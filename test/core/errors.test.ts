import { describe, expect, it } from "bun:test";
import {
  ApiError,
  AuthError,
  EXIT,
  NotFoundError,
  RateLimitError,
  RexError,
  toRexError,
  UsageError,
  ValidationError,
  WriteGatedError,
} from "../../src/core/errors";

describe("errors", () => {
  it("maps each subclass to its code + exit code", () => {
    expect([new UsageError("u").code, new UsageError("u").exitCode]).toEqual(["usage", EXIT.USAGE]);
    expect([new AuthError("a").code, new AuthError("a").exitCode]).toEqual(["auth", EXIT.AUTH]);
    expect([new RateLimitError("r").code, new RateLimitError("r").exitCode]).toEqual([
      "ratelimit",
      EXIT.RATELIMIT,
    ]);
    expect([new NotFoundError("n").code, new NotFoundError("n").exitCode]).toEqual([
      "notfound",
      EXIT.NOTFOUND,
    ]);
    expect([new ValidationError("v").code, new ValidationError("v").exitCode]).toEqual([
      "validation",
      EXIT.VALIDATION,
    ]);
    expect([new ApiError("x", 500).code, new ApiError("x", 500).exitCode]).toEqual(["api", EXIT.API]);
    expect([new WriteGatedError("w").code, new WriteGatedError("w").exitCode]).toEqual([
      "write_gated",
      EXIT.WRITE_GATED,
    ]);
  });

  it("omits details when absent and includes them when present", () => {
    expect(new ValidationError("bad").toErrorPayload()).toEqual({
      error: { code: "validation", message: "bad" },
    });
    expect(new ValidationError("bad", { details: { field: "x" } }).toErrorPayload()).toEqual({
      error: { code: "validation", message: "bad", details: { field: "x" } },
    });
  });

  it("carries http status on ApiError and retryAfter on RateLimitError", () => {
    expect(new ApiError("boom", 503).status).toBe(503);
    expect(new RateLimitError("slow", { retryAfterMs: 1500 }).retryAfterMs).toBe(1500);
  });

  it("toRexError passes RexErrors through and wraps unknowns as generic", () => {
    const original = new AuthError("nope");
    expect(toRexError(original)).toBe(original);

    const wrapped = toRexError(new Error("kaboom"));
    expect(wrapped).toBeInstanceOf(RexError);
    expect(wrapped.code).toBe("generic");
    expect(wrapped.exitCode).toBe(EXIT.GENERIC);
    expect(wrapped.message).toBe("kaboom");

    expect(toRexError("a string").message).toBe("a string");
  });
});
