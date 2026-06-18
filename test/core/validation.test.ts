import { describe, expect, it } from "bun:test";
import { ValidationError } from "../../src/core/errors";
import { parseOptionalPositiveInt, parsePositiveInt } from "../../src/core/validation";

describe("parsePositiveInt", () => {
  it("accepts positive integer values", () => {
    expect(parsePositiveInt(1, "limit")).toBe(1);
    expect(parsePositiveInt("42", "limit")).toBe(42);
    expect(parsePositiveInt("123", "limit")).toBe(123);
  });

  it("rejects non-positive, non-integer, and non-numeric values", () => {
    for (const value of [0, -1, "abc", null, "3.14"]) {
      expect(() => parsePositiveInt(value, "limit")).toThrow(ValidationError);
    }
  });

  it("accepts Number.MAX_SAFE_INTEGER and rejects larger integers", () => {
    expect(parsePositiveInt(String(Number.MAX_SAFE_INTEGER), "limit")).toBe(Number.MAX_SAFE_INTEGER);
    expect(() => parsePositiveInt(String(Number.MAX_SAFE_INTEGER + 1), "limit")).toThrow(ValidationError);
  });
});

describe("parseOptionalPositiveInt", () => {
  it("treats undefined and empty strings as absent values", () => {
    expect(parseOptionalPositiveInt(undefined, "limit")).toBeUndefined();
    expect(parseOptionalPositiveInt("", "limit")).toBeUndefined();
    expect(parseOptionalPositiveInt("   ", "limit")).toBeUndefined();
  });

  it("accepts positive integer values", () => {
    expect(parseOptionalPositiveInt("1", "limit")).toBe(1);
    expect(parseOptionalPositiveInt("42", "limit")).toBe(42);
    expect(parseOptionalPositiveInt("123", "limit")).toBe(123);
  });

  it("rejects invalid values with ValidationError", () => {
    for (const value of [0, -1, "abc", null, "3.14", String(Number.MAX_SAFE_INTEGER + 1)]) {
      expect(() => parseOptionalPositiveInt(value, "limit")).toThrow(ValidationError);
    }
  });

  it("accepts Number.MAX_SAFE_INTEGER and rejects larger integers", () => {
    expect(parseOptionalPositiveInt(String(Number.MAX_SAFE_INTEGER), "limit")).toBe(Number.MAX_SAFE_INTEGER);
    expect(() => parseOptionalPositiveInt(String(Number.MAX_SAFE_INTEGER + 1), "limit")).toThrow(ValidationError);
  });
});
