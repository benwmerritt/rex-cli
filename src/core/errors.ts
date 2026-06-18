/**
 * Stable exit codes. Agents branch on these, so they must not drift.
 *   0 ok · 1 generic · 2 usage · 3 auth · 4 ratelimit
 *   5 notfound · 6 validation · 7 api · 8 write-gated
 */
export const EXIT = {
  OK: 0,
  GENERIC: 1,
  USAGE: 2,
  AUTH: 3,
  RATELIMIT: 4,
  NOTFOUND: 5,
  VALIDATION: 6,
  API: 7,
  WRITE_GATED: 8,
} as const;

export type ErrorCode =
  | "generic"
  | "usage"
  | "auth"
  | "ratelimit"
  | "notfound"
  | "validation"
  | "api"
  | "write_gated";

export interface RexErrorOptions {
  /** Structured detail surfaced under `error.details` in JSON output. */
  details?: unknown;
  cause?: unknown;
  /** Override the default exit code for this error class. */
  exitCode?: number;
}

export interface ErrorPayload {
  error: { code: ErrorCode; message: string; details?: unknown };
}

/** Base error. Every error rex emits carries a stable `code` and `exitCode`. */
export class RexError extends Error {
  readonly code: ErrorCode;
  readonly exitCode: number;
  readonly details?: unknown;

  constructor(code: ErrorCode, message: string, exitCode: number, options: RexErrorOptions = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = new.target.name;
    this.code = code;
    this.exitCode = options.exitCode ?? exitCode;
    this.details = options.details;
  }

  toErrorPayload(): ErrorPayload {
    const error: ErrorPayload["error"] = { code: this.code, message: this.message };
    if (this.details !== undefined) error.details = this.details;
    return { error };
  }
}

/** Bad invocation / argument problem. */
export class UsageError extends RexError {
  constructor(message: string, options?: RexErrorOptions) {
    super("usage", message, EXIT.USAGE, options);
  }
}

/** Auth failure — missing/invalid key, token refresh failed, 403 permission. */
export class AuthError extends RexError {
  constructor(message: string, options?: RexErrorOptions) {
    super("auth", message, EXIT.AUTH, options);
  }
}

/** Rate limit exhausted (per-minute or per-day). */
export class RateLimitError extends RexError {
  readonly retryAfterMs?: number;
  constructor(message: string, options: RexErrorOptions & { retryAfterMs?: number } = {}) {
    super("ratelimit", message, EXIT.RATELIMIT, options);
    this.retryAfterMs = options.retryAfterMs;
  }
}

export class NotFoundError extends RexError {
  constructor(message: string, options?: RexErrorOptions) {
    super("notfound", message, EXIT.NOTFOUND, options);
  }
}

/** Local validation failure (bad input, missing profile, malformed --set). */
export class ValidationError extends RexError {
  constructor(message: string, options?: RexErrorOptions) {
    super("validation", message, EXIT.VALIDATION, options);
  }
}

/** Upstream Retail Express API error that isn't one of the more specific cases. */
export class ApiError extends RexError {
  readonly status: number;
  constructor(message: string, status: number, options?: RexErrorOptions) {
    super("api", message, EXIT.API, options);
    this.status = status;
  }
}

/** A write was refused by a guardrail (e.g. price change without --allow-price). */
export class WriteGatedError extends RexError {
  constructor(message: string, options?: RexErrorOptions) {
    super("write_gated", message, EXIT.WRITE_GATED, options);
  }
}

/** Coerce any thrown value into a RexError (unknown errors become `generic`). */
export function toRexError(err: unknown): RexError {
  if (err instanceof RexError) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new RexError("generic", message, EXIT.GENERIC, { cause: err });
}
