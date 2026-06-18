import { describe, expect, it } from "bun:test";
import { ValidationError } from "../../src/core/errors";
import { parseSet } from "../../src/core/setflags";

describe("parseSet", () => {
  it("keeps plain strings as strings", () => {
    expect(parseSet(["short_description=Acme Widget - Blue"])).toEqual({
      short_description: "Acme Widget - Blue",
    });
  });

  it("coerces numeric values only for known-numeric fields", () => {
    expect(parseSet(["sell_price_inc=9.99"])).toEqual({ sell_price_inc: 9.99 });
    expect(parseSet(["carton_quantity=6"])).toEqual({ carton_quantity: 6 });
  });

  it("keeps leading-zero SKUs/barcodes as strings (not numbers)", () => {
    expect(parseSet(["supplier_sku=0012"])).toEqual({ supplier_sku: "0012" });
    // numeric-looking, but not a known-numeric field → stays string
    expect(parseSet(["manufacturer_sku=00500"])).toEqual({ manufacturer_sku: "00500" });
  });

  it("coerces true/false/null literals", () => {
    expect(parseSet(["disabled=true", "core_product=false", "season=null"])).toEqual({
      disabled: true,
      core_product: false,
      season: null,
    });
  });

  it("parses key:=<json> as explicit JSON", () => {
    expect(parseSet(['tags:=["a","b"]', "meta:={\"k\":1}"])).toEqual({
      tags: ["a", "b"],
      meta: { k: 1 },
    });
  });

  it("supports dotted nested paths and array append", () => {
    expect(parseSet(["a.b.c=hi"])).toEqual({ a: { b: { c: "hi" } } });
    expect(parseSet(["xs[]=1", "xs[]=2"])).toEqual({ xs: ["1", "2"] });
  });

  it("throws on malformed assignments", () => {
    expect(() => parseSet(["noequalshere"])).toThrow(ValidationError);
    expect(() => parseSet(["=novalue"])).toThrow(ValidationError);
    expect(() => parseSet(["bad:=not json"])).toThrow(ValidationError);
  });
});
