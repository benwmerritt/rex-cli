import type { AuthProvider } from "./auth";
import { ApiError, AuthError, NotFoundError, RateLimitError } from "./errors";
import { noopLimiter, type RateLimiter } from "./ratelimit";
import { fetchTransport, type Transport } from "./transport";

export type QueryValue = string | number | boolean | undefined | null;

export interface RequestOptions {
  query?: Record<string, QueryValue>;
  body?: unknown;
  /** Whether the request is safe to retry on 5xx/network error. GET defaults true; writes false. */
  idempotent?: boolean;
  signal?: AbortSignal;
}

export interface RexClientOptions {
  baseUrl: string;
  version: string;
  apiKey: string;
  auth: AuthProvider;
  transport?: Transport;
  limiter?: RateLimiter;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Max retries for idempotent 5xx / network / 429. Default 4. */
  maxRetries?: number;
}

/**
 * The one place that talks to Retail Express. Responsibilities, all funnelled
 * through `request` so they can never drift per-call:
 *   - headers chokepoint: `Authorization: Bearer` + `x-api-key` on EVERY call
 *   - rate limiting via the shared limiter
 *   - retry policy: 5xx/network retried ONLY when idempotent (REX has no
 *     idempotency key, so retrying a POST could double-create); 401 refreshes
 *     the token and retries once; 403 is never retried; 429 honours Retry-After
 */
export class RexClient {
  private readonly transport: Transport;
  private readonly limiter: RateLimiter;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxRetries: number;

  constructor(private readonly opts: RexClientOptions) {
    this.transport = opts.transport ?? fetchTransport;
    this.limiter = opts.limiter ?? noopLimiter;
    this.now = opts.now ?? (() => Date.now());
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.maxRetries = opts.maxRetries ?? 4;
  }

  get<T>(path: string, opts: Omit<RequestOptions, "body"> = {}): Promise<T> {
    return this.request<T>("GET", path, opts);
  }

  async request<T>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
    const idempotent = opts.idempotent ?? method.toUpperCase() === "GET";
    const url = this.buildUrl(path, opts.query);
    let auth401Retried = false;
    let serverAttempts = 0;

    for (;;) {
      await this.limiter.acquire();
      const token = await this.opts.auth.ensureToken();

      const headers: Record<string, string> = {
        Authorization: `Bearer ${token}`,
        "x-api-key": this.opts.apiKey,
        Accept: "application/json",
      };
      let body: string | undefined;
      if (opts.body !== undefined) {
        headers["Content-Type"] = "application/json";
        body = JSON.stringify(opts.body);
      }

      let res: Response;
      try {
        res = await this.transport(url, { method, headers, body, signal: opts.signal });
      } catch (cause) {
        if (idempotent && serverAttempts < this.maxRetries) {
          serverAttempts += 1;
          await this.sleep(this.backoffMs(serverAttempts));
          continue;
        }
        throw new ApiError("Network error contacting Retail Express.", 0, { cause });
      }

      if (res.ok) return this.parse<T>(res);

      // 401 → token likely expired; refresh once and retry (safe even for writes:
      // the server rejected before processing).
      if (res.status === 401 && !auth401Retried) {
        auth401Retried = true;
        this.opts.auth.invalidate();
        continue;
      }
      if (res.status === 401 || res.status === 403) {
        throw new AuthError(`Retail Express rejected the request (HTTP ${res.status}).`, {
          details: { status: res.status, body: await safeBody(res) },
        });
      }
      if (res.status === 404) {
        throw new NotFoundError(`Not found: ${method} ${path}`, { details: { status: 404 } });
      }
      if (res.status === 429) {
        const retryAfter = parseRetryAfter(res, this.now());
        if (serverAttempts < this.maxRetries) {
          serverAttempts += 1;
          await this.sleep(retryAfter ?? this.backoffMs(serverAttempts));
          continue;
        }
        throw new RateLimitError("Retail Express rate limit exceeded.", {
          retryAfterMs: retryAfter,
          details: { status: 429 },
        });
      }
      if (res.status >= 500) {
        if (idempotent && serverAttempts < this.maxRetries) {
          serverAttempts += 1;
          await this.sleep(this.backoffMs(serverAttempts));
          continue;
        }
        throw new ApiError(`Retail Express server error (HTTP ${res.status}).`, res.status, {
          details: { body: await safeBody(res) },
        });
      }
      throw new ApiError(`Retail Express returned HTTP ${res.status}.`, res.status, {
        details: { body: await safeBody(res) },
      });
    }
  }

  buildUrl(path: string, query?: Record<string, QueryValue>): string {
    const base = `${this.opts.baseUrl}/${this.opts.version}/${path.replace(/^\/+/, "")}`;
    if (!query) return base;
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null) params.set(key, String(value));
    }
    const qs = params.toString();
    return qs ? `${base}?${qs}` : base;
  }

  private async parse<T>(res: Response): Promise<T> {
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    if (text.length === 0) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch (cause) {
      throw new ApiError("Could not parse Retail Express response as JSON.", res.status, { cause });
    }
  }

  /** Exponential backoff with full jitter (capped). */
  private backoffMs(attempt: number): number {
    const base = Math.min(30_000, 500 * 2 ** (attempt - 1));
    return Math.floor(Math.random() * base);
  }
}

async function safeBody(res: Response): Promise<unknown> {
  try {
    const text = await res.text();
    if (!text) return undefined;
    try {
      return JSON.parse(text);
    } catch {
      return text.slice(0, 500);
    }
  } catch {
    return undefined;
  }
}

/** Retry-After may be seconds or an HTTP date. Returns ms, or undefined. */
function parseRetryAfter(res: Response, nowMs: number): number | undefined {
  const header = res.headers.get("retry-after");
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(header);
  if (Number.isFinite(date)) return Math.max(0, date - nowMs);
  return undefined;
}
