import { describe, expect, it } from "bun:test";
import {
  createSession,
  parseCountArgs,
  summarizeSession,
  upsertLine,
  type ResolvedProduct,
} from "../../src/resources/stocktake";

const product: ResolvedProduct = {
  id: 124001,
  description: "Weber Q",
  sku: "WQ",
  raw: { id: 124001, short_description: "Weber Q" },
};

describe("stocktake resource helpers", () => {
  it("parses natural count args by treating the last token as the count", () => {
    expect(parseCountArgs(["weber", "q", "2200", "6"])).toEqual({
      query: "weber q 2200",
      counted: 6,
    });
  });

  it("calculates variance from the absolute counted quantity", () => {
    const session = createSession({
      profile: "test",
      outlet: { id: 3, name: "Mile End" },
      userId: 4,
      now: () => "2026-06-18T00:00:00.000Z",
    });
    const result = upsertLine(session, {
      query: "weber q",
      product,
      counted: 6,
      currentStock: 8,
      now: () => "2026-06-18T00:01:00.000Z",
    });
    expect(result.line).toMatchObject({ productId: 124001, counted: 6, currentStock: 8, variance: -2 });
    expect(summarizeSession(session)).toMatchObject({ totalLines: 1, submitLines: 1, negativeVariance: -2 });
  });

  it("updates an existing line when the same product is counted again", () => {
    const session = createSession({ profile: "test", outlet: { id: 3 }, userId: 4 });
    upsertLine(session, { query: "weber q", product, counted: 6, currentStock: 8 });
    const result = upsertLine(session, { query: "weber q", product, counted: 8, currentStock: 8 });
    expect(result.updated).toBe(true);
    expect(session.lines).toHaveLength(1);
    expect(session.lines[0]).toMatchObject({ counted: 8, variance: 0 });
    expect(summarizeSession(session)).toMatchObject({ totalLines: 1, submitLines: 0, zeroVarianceLines: 1 });
  });
});
