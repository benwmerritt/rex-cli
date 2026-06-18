import type { Profile } from "./config";
import { ApiError, ValidationError } from "./errors";
import { fetchTransport, type Transport } from "./transport";

export interface WmsConfig {
  clientId: string;
  username: string;
  password: string;
  url: string;
}

export interface StocktakeItem {
  productId: number;
  variance: number;
}

export interface CreateStocktakeInput {
  outletId: number;
  userId: number;
  items: StocktakeItem[];
}

export interface CreateStocktakeResult {
  ok: boolean;
  result: string;
  message?: string;
}

export interface CreateStocktakeOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface WmsClientLike {
  createStocktake(input: CreateStocktakeInput, options?: CreateStocktakeOptions): Promise<CreateStocktakeResult>;
}

export interface TimeoutScheduler {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(timeout: unknown): void;
}

export type TimeoutSignalFactory = (timeoutMs: number) => AbortSignal;

export interface WmsClientOptions {
  config: WmsConfig;
  transport?: Transport;
  signal?: AbortSignal;
  timeoutMs?: number;
  timeoutScheduler?: TimeoutScheduler;
  timeoutSignalFactory?: TimeoutSignalFactory;
}

export const DEFAULT_WMS_TIMEOUT_MS = 30_000;

export function requireWmsConfig(profile: Profile): WmsConfig {
  const clientId = profile.wmsClientId;
  const username = profile.wmsUsername;
  const password = profile.wmsPassword;
  const url = profile.wmsUrl;
  const missing: string[] = [];
  if (!clientId) missing.push("wms_client_id / REX_WMS_CLIENT_ID");
  if (!username) missing.push("wms_username / REX_WMS_USERNAME");
  if (!password) missing.push("wms_password / REX_WMS_PASSWORD");
  if (!url) missing.push("wms_url / REX_WMS_URL");
  if (missing.length > 0) {
    throw new ValidationError("WMS SOAP credentials are required for stocktake.", {
      details: {
        missing,
        hint: "Run `rex config wms <profile> --client-id ... --username ... --password ... --url ...`.",
      },
    });
  }
  return {
    clientId: clientId!,
    username: username!,
    password: password!,
    url: url!,
  };
}

export class WmsClient implements WmsClientLike {
  private readonly transport: Transport;

  constructor(private readonly opts: WmsClientOptions) {
    this.transport = opts.transport ?? fetchTransport;
  }

  async createStocktake(input: CreateStocktakeInput, options: CreateStocktakeOptions = {}): Promise<CreateStocktakeResult> {
    validateCreateStocktake(input);
    const timeoutMs = resolveTimeoutMs(options.timeoutMs ?? this.opts.timeoutMs);
    const request = createRequestSignal({
      signal: options.signal ?? this.opts.signal,
      timeoutMs,
      scheduler: this.opts.timeoutScheduler,
      timeoutSignalFactory: this.opts.timeoutSignalFactory ?? nativeTimeoutSignal,
    });
    try {
      const res = await this.transport(postUrl(this.opts.config.url), {
        method: "POST",
        headers: {
          "Content-Type": "text/xml; charset=utf-8",
          SOAPAction: '"http://retailexpress.com.au/CreateStocktake"',
        },
        body: createStocktakeEnvelope(this.opts.config, input),
        signal: request.signal,
      });
      const text = await res.text();
      if (!res.ok) {
        throw new ApiError(`Retail Express WMS returned HTTP ${res.status}.`, res.status, {
          details: { body: text.slice(0, 1000) },
        });
      }
      return parseCreateStocktakeResponse(text, res.status);
    } catch (err) {
      if (request.timedOut()) {
        throw new ApiError(`Retail Express WMS request timed out after ${timeoutMs}ms.`, 0, { cause: err });
      }
      throw err;
    } finally {
      request.cleanup();
    }
  }
}

export function createStocktakeEnvelope(config: WmsConfig, input: CreateStocktakeInput): string {
  const items = input.items
    .map(
      (item) => `<ret:ItemValue><ret:Item>${item.productId}</ret:Item><ret:Value>${item.variance}</ret:Value></ret:ItemValue>`,
    )
    .join("");
  return `<?xml version="1.0" encoding="utf-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ret="http://retailexpress.com.au/">
  <soapenv:Header>
    <ret:ClientHeader>
      <ret:ClientID>${escapeXml(config.clientId)}</ret:ClientID>
      <ret:UserName>${escapeXml(config.username)}</ret:UserName>
      <ret:Password>${escapeXml(config.password)}</ret:Password>
    </ret:ClientHeader>
  </soapenv:Header>
  <soapenv:Body>
    <ret:CreateStocktake>
      <ret:list>${items}</ret:list>
      <ret:whid>${input.outletId}</ret:whid>
      <ret:userId>${input.userId}</ret:userId>
    </ret:CreateStocktake>
  </soapenv:Body>
</soapenv:Envelope>`;
}

export function parseCreateStocktakeResponse(text: string, status = 200): CreateStocktakeResult {
  const fault = tag(text, "faultstring");
  if (fault) {
    throw new ApiError(`Retail Express WMS SOAP fault: ${decodeXml(fault)}`, status, {
      details: { fault: decodeXml(fault) },
    });
  }

  const encoded = tag(text, "CreateStocktakeResult");
  if (!encoded) {
    throw new ApiError("Retail Express WMS response did not include CreateStocktakeResult.", status, {
      details: { body: text.slice(0, 1000) },
    });
  }

  const inner = decodeXml(encoded);
  const result = decodeXml(tag(inner, "Result") ?? "");
  const message = decodeXml(tag(inner, "Message") ?? "").trim();
  if (result.toLowerCase() !== "success") {
    throw new ApiError(`Retail Express WMS stocktake failed: ${message || result || "unknown error"}`, status, {
      details: { result, message },
    });
  }
  return { ok: true, result, ...(message ? { message } : {}) };
}

function validateCreateStocktake(input: CreateStocktakeInput): void {
  if (!Number.isInteger(input.outletId) || input.outletId <= 0) {
    throw new ValidationError("Stocktake outlet id must be a positive integer.");
  }
  if (!Number.isInteger(input.userId) || input.userId <= 0) {
    throw new ValidationError("Stocktake user id must be a positive integer.");
  }
  if (input.items.length === 0) throw new ValidationError("Stocktake submit needs at least one item.");
  for (const item of input.items) {
    if (!Number.isInteger(item.productId) || item.productId <= 0) {
      throw new ValidationError("Stocktake product ids must be positive integers.", { details: { item } });
    }
    if (!Number.isInteger(item.variance)) {
      throw new ValidationError("Stocktake variances must be integers.", { details: { item } });
    }
  }
}

function resolveTimeoutMs(timeoutMs: number | undefined): number {
  const resolved = timeoutMs ?? DEFAULT_WMS_TIMEOUT_MS;
  if (!Number.isInteger(resolved) || resolved <= 0) {
    throw new ValidationError("WMS request timeout must be a positive integer.");
  }
  return resolved;
}

function createRequestSignal(input: {
  signal?: AbortSignal;
  timeoutMs: number;
  scheduler?: TimeoutScheduler;
  timeoutSignalFactory: TimeoutSignalFactory;
}): { signal: AbortSignal; cleanup: () => void; timedOut: () => boolean } {
  if (!input.scheduler) {
    return createNativeRequestSignal({
      signal: input.signal,
      timeoutMs: input.timeoutMs,
      timeoutSignalFactory: input.timeoutSignalFactory,
    });
  }
  return createScheduledRequestSignal({
    signal: input.signal,
    timeoutMs: input.timeoutMs,
    scheduler: input.scheduler,
  });
}

function createScheduledRequestSignal(input: {
  signal?: AbortSignal;
  timeoutMs: number;
  scheduler: TimeoutScheduler;
}): { signal: AbortSignal; cleanup: () => void; timedOut: () => boolean } {
  const controller = new AbortController();
  let timedOut = false;
  const abortFromParent = () => controller.abort(input.signal?.reason);

  if (input.signal) {
    if (input.signal.aborted) abortFromParent();
    else input.signal.addEventListener("abort", abortFromParent, { once: true });
  }

  const timeout = input.scheduler.setTimeout(() => {
    timedOut = true;
    controller.abort(new Error("WMS request timed out."));
  }, input.timeoutMs);

  return {
    signal: controller.signal,
    cleanup: () => {
      input.scheduler.clearTimeout(timeout);
      input.signal?.removeEventListener("abort", abortFromParent);
    },
    timedOut: () => timedOut,
  };
}

function createNativeRequestSignal(input: {
  signal?: AbortSignal;
  timeoutMs: number;
  timeoutSignalFactory: TimeoutSignalFactory;
}): { signal: AbortSignal; cleanup: () => void; timedOut: () => boolean } {
  const timeoutSignal = input.timeoutSignalFactory(input.timeoutMs);
  let timedOut = timeoutSignal.aborted;
  const markTimedOut = () => {
    timedOut = true;
  };
  if (!timeoutSignal.aborted) timeoutSignal.addEventListener("abort", markTimedOut, { once: true });

  if (!input.signal) {
    return {
      signal: timeoutSignal,
      cleanup: () => timeoutSignal.removeEventListener("abort", markTimedOut),
      timedOut: () => timedOut,
    };
  }

  const combined = combineSignals(input.signal, timeoutSignal);
  return {
    signal: combined.signal,
    cleanup: () => {
      timeoutSignal.removeEventListener("abort", markTimedOut);
      combined.cleanup();
    },
    timedOut: () => timedOut,
  };
}

function combineSignals(parentSignal: AbortSignal, timeoutSignal: AbortSignal): { signal: AbortSignal; cleanup: () => void } {
  if (typeof AbortSignal.any === "function") {
    return { signal: AbortSignal.any([parentSignal, timeoutSignal]), cleanup: () => {} };
  }

  const controller = new AbortController();
  const abortFromParent = () => controller.abort(parentSignal.reason);
  const abortFromTimeout = () => controller.abort(timeoutSignal.reason);

  if (parentSignal.aborted) abortFromParent();
  else parentSignal.addEventListener("abort", abortFromParent, { once: true });
  if (timeoutSignal.aborted) abortFromTimeout();
  else timeoutSignal.addEventListener("abort", abortFromTimeout, { once: true });

  return {
    signal: controller.signal,
    cleanup: () => {
      parentSignal.removeEventListener("abort", abortFromParent);
      timeoutSignal.removeEventListener("abort", abortFromTimeout);
    },
  };
}

function nativeTimeoutSignal(timeoutMs: number): AbortSignal {
  return AbortSignal.timeout(timeoutMs);
}

function postUrl(url: string): string {
  return url.replace(/\?wsdl$/i, "");
}

function tag(text: string, name: string): string | undefined {
  // SAFETY: all call sites pass hardcoded alphanumeric tag names, not user input.
  const re = new RegExp(`<(?:[A-Za-z0-9_]+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[A-Za-z0-9_]+:)?${name}>`, "i");
  return re.exec(text)?.[1];
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function decodeXml(value: string): string {
  let decoded = value;
  for (let i = 0; i < 5; i += 1) {
    const next = decodeXmlOnce(decoded);
    if (next === decoded) return decoded;
    decoded = next;
  }
  return decoded;
}

function decodeXmlOnce(value: string): string {
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}
