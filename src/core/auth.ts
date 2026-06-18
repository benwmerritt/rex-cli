import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { AuthError } from "./errors";
import { tokenCacheFile } from "./paths";
import type { Transport } from "./transport";

/** Shape returned by `POST /{version}/auth/token`. */
export interface TokenResponse {
  token_type?: string;
  access_token: string;
  expires_on?: string;
}

interface CachedToken {
  accessToken: string;
  /** Epoch milliseconds. */
  expiresAt: number;
}

export interface AuthProvider {
  /** Return a valid bearer token, refreshing (and caching) if needed. */
  ensureToken(): Promise<string>;
  /** Drop the cached token (memory + disk). Called after a 401. */
  invalidate(): void;
}

export interface CreateAuthOptions {
  apiKey: string;
  baseUrl: string;
  version: string;
  /** Version segment for the token endpoint. Defaults to "v2" (auth lives on /v2 even when the data API is v2.1). */
  tokenVersion?: string;
  profile: string;
  transport: Transport;
  /** Injectable clock (epoch ms). Defaults to Date.now. */
  now?: () => number;
  /** Explicit token-cache path; defaults to the per-profile cache file. */
  cachePath?: string;
  /** Refresh when within this many ms of expiry. Default 5 min. */
  refreshSkewMs?: number;
  /** Used when `expires_on` is missing/unparseable. Default 55 min. */
  tokenTtlFallbackMs?: number;
}

const DEFAULT_SKEW = 5 * 60_000;
const DEFAULT_TTL_FALLBACK = 55 * 60_000;

/**
 * Retail Express bearer tokens last 60 minutes. Because each rex invocation is
 * a fresh process, the token is cached to disk (per profile) so successive
 * commands don't each pay an /auth/token round-trip (which also counts against
 * the rate budget). Disk writes are atomic (temp + rename) to tolerate two
 * processes refreshing at once.
 */
export function createAuth(opts: CreateAuthOptions): AuthProvider {
  const now = opts.now ?? (() => Date.now());
  const skew = opts.refreshSkewMs ?? DEFAULT_SKEW;
  const ttlFallback = opts.tokenTtlFallbackMs ?? DEFAULT_TTL_FALLBACK;
  const cachePath = opts.cachePath ?? tokenCacheFile(opts.profile);
  let memory: CachedToken | undefined;

  function isValid(token: CachedToken | undefined): token is CachedToken {
    return token !== undefined && token.expiresAt - now() > skew;
  }

  function readDisk(): CachedToken | undefined {
    try {
      const raw = JSON.parse(readFileSync(cachePath, "utf8")) as Partial<CachedToken>;
      if (typeof raw.accessToken === "string" && typeof raw.expiresAt === "number") {
        return { accessToken: raw.accessToken, expiresAt: raw.expiresAt };
      }
    } catch {
      // missing or corrupt cache → treat as no cache
    }
    return undefined;
  }

  function writeDisk(token: CachedToken): void {
    mkdirSync(dirname(cachePath), { recursive: true, mode: 0o700 });
    const tmp = `${cachePath}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(token), { mode: 0o600 });
    renameSync(tmp, cachePath);
  }

  async function fetchToken(): Promise<CachedToken> {
    // NOTE: the live endpoint is GET, despite the official docs/dlt/Airbyte all
    // describing POST — POST returns a gateway 404 ("Resource not found"). The
    // token always comes from /v2/auth/token regardless of the data API version.
    const url = `${opts.baseUrl}/${opts.tokenVersion ?? "v2"}/auth/token`;
    let res: Response;
    try {
      res = await opts.transport(url, {
        method: "GET",
        headers: { "x-api-key": opts.apiKey, Accept: "application/json" },
      });
    } catch (cause) {
      throw new AuthError("Could not reach the Retail Express auth endpoint.", { cause });
    }
    if (!res.ok) {
      throw new AuthError(`Auth token request failed (HTTP ${res.status}).`, {
        details: { status: res.status },
      });
    }
    const body = (await res.json()) as TokenResponse;
    if (!body || typeof body.access_token !== "string") {
      throw new AuthError("Auth token response did not include an access_token.");
    }
    // Parse expires_on defensively (timezone/format may vary); fall back to a
    // conservative TTL if it doesn't parse so we never treat a token as eternal.
    const parsed = body.expires_on ? Date.parse(body.expires_on) : Number.NaN;
    const expiresAt = Number.isFinite(parsed) ? parsed : now() + ttlFallback;
    return { accessToken: body.access_token, expiresAt };
  }

  return {
    async ensureToken(): Promise<string> {
      if (isValid(memory)) return memory.accessToken;

      const disk = readDisk();
      if (isValid(disk)) {
        memory = disk;
        return disk.accessToken;
      }

      const fresh = await fetchToken();
      memory = fresh;
      try {
        writeDisk(fresh);
      } catch {
        // caching is best-effort; a failed write just means a refresh next time
      }
      return fresh.accessToken;
    },

    invalidate(): void {
      memory = undefined;
      try {
        rmSync(cachePath, { force: true });
      } catch {
        // ignore
      }
    },
  };
}
