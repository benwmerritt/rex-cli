import { describe, expect, it } from "bun:test";
import { classifyChanged, PRICE_FIELDS, topLevelField } from "../../src/core/fields";

describe("fields", () => {
  it("knows the core price fields", () => {
    expect(PRICE_FIELDS.has("sell_price_inc")).toBe(true);
    expect(PRICE_FIELDS.has("web_price_inc")).toBe(true);
    expect(PRICE_FIELDS.has("fixed_price_groups")).toBe(true);
    expect(PRICE_FIELDS.has("short_description")).toBe(false);
  });

  it("topLevelField strips nested/array suffixes", () => {
    expect(topLevelField("price_groups[0].value")).toBe("price_groups");
    expect(topLevelField("pricing.pos")).toBe("pricing");
    expect(topLevelField("brand")).toBe("brand");
  });

  it("classifyChanged splits price-gated from freely-writable", () => {
    const { price, safe } = classifyChanged([
      "short_description",
      "web_price_inc",
      "brand",
      "fixed_price_groups",
    ]);
    expect(price.sort()).toEqual(["fixed_price_groups", "web_price_inc"]);
    expect(safe.sort()).toEqual(["brand", "short_description"]);
  });
});
