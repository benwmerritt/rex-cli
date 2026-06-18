import { describe, expect, it } from "bun:test";
import { computeDiff, deepEqual } from "../../src/core/diff";

describe("computeDiff", () => {
  it("includes only fields that actually changed", () => {
    const current = { id: 1, short_description: "Old", brand: "Acme", product_type: "Widgets" };
    const desired = { short_description: "New", brand: "Acme" };
    const d = computeDiff(current, desired);
    expect(d.changed).toEqual({ short_description: "New" });
    expect(d.changedKeys).toEqual(["short_description"]);
  });

  it("returns an empty diff when nothing changed", () => {
    expect(computeDiff({ a: 1, b: 2 }, { a: 1 }).changedKeys).toEqual([]);
  });

  it("includes a brand-new field absent from current", () => {
    expect(computeDiff({ id: 1 }, { season: "Summer" }).changed).toEqual({ season: "Summer" });
  });

  it("sends a nested object whole when any leaf differs", () => {
    const current = { pricing: { pos: 10, web: 12 } };
    const desired = { pricing: { pos: 10, web: 15 } };
    expect(computeDiff(current, desired).changed).toEqual({ pricing: { pos: 10, web: 15 } });
  });

  it("replaces an array whole when it differs", () => {
    const current = { barcodes: ["a", "b"] };
    const desired = { barcodes: ["a", "b", "c"] };
    expect(computeDiff(current, desired).changed).toEqual({ barcodes: ["a", "b", "c"] });
  });

  it("flags touched price fields", () => {
    const d = computeDiff({ web_price_inc: 10, brand: "x" }, { web_price_inc: 12, brand: "y" });
    expect(d.touchedPriceFields).toEqual(["web_price_inc"]);
    expect(d.changedKeys.sort()).toEqual(["brand", "web_price_inc"]);
  });
});

describe("deepEqual", () => {
  it("compares scalars, arrays, and nested objects structurally", () => {
    expect(deepEqual(1, 1)).toBe(true);
    expect(deepEqual("a", "b")).toBe(false);
    expect(deepEqual(1, "1")).toBe(false);
    expect(deepEqual([1, [2, 3]], [1, [2, 3]])).toBe(true);
    expect(deepEqual({ a: { b: 1 } }, { a: { b: 1 } })).toBe(true);
    expect(deepEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(deepEqual(null, undefined)).toBe(false);
  });
});
