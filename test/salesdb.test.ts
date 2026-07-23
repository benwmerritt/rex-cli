import { beforeEach, describe, expect, it } from "bun:test";
import type { Database } from "bun:sqlite";
import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  dbSummary,
  getMeta,
  openSalesDb,
  type OrderItemRow,
  type OrderRow,
  runReport,
  salesDbFile,
  setMeta,
  upsertOrder,
} from "../src/core/salesdb";

// ---- fixture ---------------------------------------------------------------

function order(over: Partial<OrderRow> & { id: number; createdOn: string; orderTotal: number }): OrderRow {
  return {
    createdTs: Date.parse(over.createdOn),
    dayLocal: over.createdOn.slice(0, 10),
    monthLocal: over.createdOn.slice(0, 7),
    modifiedOn: over.createdOn,
    statusId: 1,
    statusName: "Fulfilled",
    salespersonId: null,
    salespersonName: null,
    outletId: null,
    outletName: null,
    freightTotal: 0,
    customerId: null,
    ...over,
  };
}

function item(over: Partial<OrderItemRow> & { id: number; orderId: number; lineTotal: number }): OrderItemRow {
  return {
    productId: null,
    productName: null,
    productTypeId: null,
    productTypeName: null,
    itemType: null,
    quantity: 1,
    sellPrice: over.lineTotal,
    discountTotal: 0,
    taxRate: 0.1,
    cogsEx: 0,
    ...over,
  };
}

const ALICE = { salespersonId: 1, salespersonName: "Alice" };
const BOB = { salespersonId: 2, salespersonName: "Bob" };
const CITY = { outletId: 10, outletName: "City" };
const BEACH = { outletId: 11, outletName: "Beach" };
const P100 = { productId: 100, productName: "Widget", productTypeId: 1, productTypeName: "Toys" };
const P101 = { productId: 101, productName: "Gadget", productTypeId: 1, productTypeName: "Toys" };
const P102 = { productId: 102, productName: "Gizmo", productTypeId: 2, productTypeName: "Tools" };

/**
 * 8 orders, 2 salespeople x 2 outlets x 3 products across Jun+Jul 2025.
 * Tax rate 0.1 everywhere so ex-GST = inc / 1.1. Hand-computed expectations:
 *   Alice revenue 110+220-110+165 = 385, units 4, profit 200
 *   Bob   revenue 330+55+165     = 550, units 5, profit 250
 *   O5 (999, Cancelled), O9 (777, Quote), O10 (888, Incomplete) must never
 *   appear anywhere.
 */
function seed(db: Database): void {
  // O1 Alice/City Jun: P100 x1 @110, cogs 50/u -> profit 100-50 = 50
  upsertOrder(db, order({ id: 1, createdOn: "2025-06-05T02:00:00.000Z", orderTotal: 110, ...ALICE, ...CITY }), [
    item({ id: 11, orderId: 1, lineTotal: 110, cogsEx: 50, ...P100 }),
  ]);
  // O2 Alice/Beach Jun: P101 x2 @220, cogs 40/u -> profit 200-80 = 120
  upsertOrder(db, order({ id: 2, createdOn: "2025-06-10T02:00:00.000Z", orderTotal: 220, ...ALICE, ...BEACH }), [
    item({ id: 21, orderId: 2, lineTotal: 220, quantity: 2, cogsEx: 40, ...P101 }),
  ]);
  // O3 Bob/City Jun: P100 x1 @110 (50) + P102 x2 @220, cogs 60/u (200-120=80) -> 130
  upsertOrder(db, order({ id: 3, createdOn: "2025-06-15T02:00:00.000Z", orderTotal: 330, ...BOB, ...CITY }), [
    item({ id: 31, orderId: 3, lineTotal: 110, cogsEx: 50, ...P100 }),
    item({ id: 32, orderId: 3, lineTotal: 220, quantity: 2, cogsEx: 60, ...P102 }),
  ]);
  // O4 Bob/Beach Jul: P101 x1 @55, cogs 20 -> 50-20 = 30
  upsertOrder(db, order({ id: 4, createdOn: "2025-07-02T02:00:00.000Z", orderTotal: 55, ...BOB, ...BEACH }), [
    item({ id: 41, orderId: 4, lineTotal: 55, cogsEx: 20, ...P101 }),
  ]);
  // O5 Alice/City Jul, Cancelled: excluded from every report
  upsertOrder(
    db,
    order({ id: 5, createdOn: "2025-07-05T02:00:00.000Z", orderTotal: 999, statusId: 9, statusName: "Cancelled", ...ALICE, ...CITY }),
    [item({ id: 51, orderId: 5, lineTotal: 999, ...P100 })],
  );
  // O6 Alice/City Jul, return: P100 x-1 @-110, cogs 50/u -> -100 + 50 = -50
  upsertOrder(db, order({ id: 6, createdOn: "2025-07-10T02:00:00.000Z", orderTotal: -110, ...ALICE, ...CITY }), [
    item({ id: 61, orderId: 6, lineTotal: -110, quantity: -1, itemType: "Return", cogsEx: 50, ...P100 }),
  ]);
  // O7 Bob/City Jul: P102 x1 @165, cogs 60 -> 150-60 = 90
  upsertOrder(db, order({ id: 7, createdOn: "2025-07-15T02:00:00.000Z", orderTotal: 165, ...BOB, ...CITY }), [
    item({ id: 71, orderId: 7, lineTotal: 165, cogsEx: 60, ...P102 }),
  ]);
  // O8 Alice/Beach Jul: P100 x1 @110 (50) + P101 x1 @55 (30) -> 80
  upsertOrder(db, order({ id: 8, createdOn: "2025-07-20T02:00:00.000Z", orderTotal: 165, ...ALICE, ...BEACH }), [
    item({ id: 81, orderId: 8, lineTotal: 110, cogsEx: 50, ...P100 }),
    item({ id: 82, orderId: 8, lineTotal: 55, cogsEx: 20, ...P101 }),
  ]);
  // O9/O10 Alice/City Jul, Quote + Incomplete: not committed, excluded everywhere
  upsertOrder(
    db,
    order({ id: 9, createdOn: "2025-07-21T02:00:00.000Z", orderTotal: 777, statusId: 1, statusName: "Quote", ...ALICE, ...CITY }),
    [item({ id: 91, orderId: 9, lineTotal: 777, ...P100 })],
  );
  upsertOrder(
    db,
    order({ id: 10, createdOn: "2025-07-22T02:00:00.000Z", orderTotal: 888, statusId: 2, statusName: "Incomplete", ...ALICE, ...CITY }),
    [item({ id: 101, orderId: 10, lineTotal: 888, ...P100 })],
  );
}

const FROM = Date.parse("2025-06-01T00:00:00.000Z");
const JULY = Date.parse("2025-07-01T00:00:00.000Z");
const TO = Date.parse("2025-08-01T00:00:00.000Z");

describe("salesdb", () => {
  let db: Database;

  beforeEach(() => {
    db = openSalesDb(":memory:");
    seed(db);
  });

  it("salesDbFile joins profile into stateDir and rejects unsafe names", () => {
    expect(salesDbFile("default").endsWith("sales.default.db")).toBe(true);
    expect(() => salesDbFile("../evil")).toThrow();
  });

  it("openSalesDb creates parent dirs, stamps schema_version, and reopens idempotently", () => {
    const tmpRoot = join(tmpdir(), `rex-salesdb-test-${Date.now()}`);
    const path = join(tmpRoot, "nested", "sales.db");
    try {
      openSalesDb(path).close();
      expect(existsSync(path)).toBe(true);
      const reopened = openSalesDb(path); // schema re-apply must not throw
      expect(getMeta(reopened, "schema_version")).toBe("1");
      reopened.close();
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it("meta round-trips and overwrites", () => {
    expect(getMeta(db, "watermark")).toBeNull();
    setMeta(db, "watermark", "2025-07-01T00:00:00Z");
    setMeta(db, "watermark", "2025-07-02T00:00:00Z");
    expect(getMeta(db, "watermark")).toBe("2025-07-02T00:00:00Z");
  });

  it("upsertOrder is idempotent and replaces items on re-run", () => {
    expect(dbSummary(db)).toEqual({
      orders: 10,
      items: 12,
      minCreatedOn: "2025-06-05T02:00:00.000Z",
      maxCreatedOn: "2025-07-22T02:00:00.000Z",
    });

    // Identical re-run: counts unchanged.
    upsertOrder(db, order({ id: 3, createdOn: "2025-06-15T02:00:00.000Z", orderTotal: 330, ...BOB, ...CITY }), [
      item({ id: 31, orderId: 3, lineTotal: 110, cogsEx: 50, ...P100 }),
      item({ id: 32, orderId: 3, lineTotal: 220, quantity: 2, cogsEx: 60, ...P102 }),
    ]);
    expect(dbSummary(db).orders).toBe(10);
    expect(dbSummary(db).items).toBe(12);

    // Fewer items on re-sync: old lines must not linger.
    upsertOrder(db, order({ id: 3, createdOn: "2025-06-15T02:00:00.000Z", orderTotal: 110, ...BOB, ...CITY }), [
      item({ id: 31, orderId: 3, lineTotal: 110, cogsEx: 50, ...P100 }),
    ]);
    expect(dbSummary(db).items).toBe(11);
  });

  it("revenue by salesperson matches hand-computed inc-GST header sums, sorted revenue desc", () => {
    const rows = runReport(db, { fromTs: FROM, toTs: TO, by: ["salesperson"] });
    expect(rows).toEqual([
      { salesperson_id: 2, salesperson_name: "Bob", revenue: 550, units: 5, gross_profit_ex: 250, orders: 3 },
      { salesperson_id: 1, salesperson_name: "Alice", revenue: 385, units: 4, gross_profit_ex: 200, orders: 4 },
    ]);
  });

  it("excludes Cancelled, Quote, and Incomplete orders from header totals", () => {
    const [row] = runReport(db, { fromTs: FROM, toTs: TO, by: [] });
    expect(row).toEqual({ revenue: 935, units: 9, gross_profit_ex: 450, orders: 7 });
  });

  it("rejects unknown dimensions, unknown sort keys, and non-positive top", () => {
    expect(() => runReport(db, { fromTs: FROM, toTs: TO, by: ["bogus" as never] })).toThrow();
    expect(() => runReport(db, { fromTs: FROM, toTs: TO, by: [], sort: "bogus" as never })).toThrow();
    expect(() => runReport(db, { fromTs: FROM, toTs: TO, by: [], top: 0 })).toThrow();
    expect(() => runReport(db, { fromTs: FROM, toTs: TO, by: [], top: 1.5 })).toThrow();
  });

  it("counts Awaiting Payment orders as Sales (accrual basis)", () => {
    upsertOrder(
      db,
      order({ id: 11, createdOn: "2025-07-23T02:00:00.000Z", orderTotal: 44, statusId: 3, statusName: "Awaiting Payment", ...BOB, ...CITY }),
      [item({ id: 111, orderId: 11, lineTotal: 44, cogsEx: 10, ...P100 })],
    );
    const [row] = runReport(db, { fromTs: FROM, toTs: TO, by: [] });
    expect(row).toEqual({ revenue: 979, units: 10, gross_profit_ex: 480, orders: 8 });
  });

  it("filters by the half-open [from, to) range", () => {
    const [june] = runReport(db, { fromTs: FROM, toTs: JULY, by: [] });
    expect(june).toMatchObject({ revenue: 660, orders: 3 });
  });

  it("month grouping buckets by month_local", () => {
    const rows = runReport(db, { fromTs: FROM, toTs: TO, by: ["month"] });
    expect(rows).toEqual([
      { month: "2025-06", revenue: 660, units: 6, gross_profit_ex: 300, orders: 3 },
      { month: "2025-07", revenue: 275, units: 3, gross_profit_ex: 150, orders: 4 },
    ]);
  });

  it("product report aggregates line totals, returns net off, Cancelled lines excluded", () => {
    const rows = runReport(db, { fromTs: FROM, toTs: TO, by: ["product"] });
    expect(rows).toEqual([
      { product_id: 102, product_name: "Gizmo", product_type_name: "Tools", revenue: 385, units: 3, gross_profit_ex: 170, orders: 2 },
      { product_id: 101, product_name: "Gadget", product_type_name: "Toys", revenue: 330, units: 4, gross_profit_ex: 180, orders: 3 },
      // 999 Cancelled line excluded; O6 return (-110 / -1 unit / -50 profit) netted off.
      { product_id: 100, product_name: "Widget", product_type_name: "Toys", revenue: 220, units: 2, gross_profit_ex: 100, orders: 4 },
    ]);
  });

  it("sort=profit orders by gross_profit_ex desc; sort=units by units desc", () => {
    const byProfit = runReport(db, { fromTs: FROM, toTs: TO, by: ["product"], sort: "profit" });
    expect(byProfit.map((r) => r.product_id)).toEqual([101, 102, 100]);
    const byUnits = runReport(db, { fromTs: FROM, toTs: TO, by: ["product"], sort: "units" });
    expect(byUnits.map((r) => r.product_id)).toEqual([101, 102, 100]);
  });

  it("top limits rows after sorting", () => {
    const rows = runReport(db, { fromTs: FROM, toTs: TO, by: ["salesperson"], top: 1 });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ salesperson_name: "Bob" });
  });

  it("productId filters line-level even without a product grouping", () => {
    const [row] = runReport(db, { fromTs: FROM, toTs: TO, by: [], productId: 100 });
    expect(row).toEqual({ revenue: 220, units: 2, gross_profit_ex: 100, orders: 4 });
  });

  it("groups by outlet with header totals", () => {
    const rows = runReport(db, { fromTs: FROM, toTs: TO, by: ["outlet"] });
    // City: 110+330-110+165 = 495; Beach: 220+55+165 = 440
    expect(rows).toEqual([
      { outlet_id: 10, outlet_name: "City", revenue: 495, units: 4, gross_profit_ex: 220, orders: 4 },
      { outlet_id: 11, outlet_name: "Beach", revenue: 440, units: 5, gross_profit_ex: 230, orders: 3 },
    ]);
  });

  it("rounds money to 2dp at the edge", () => {
    const fresh = openSalesDb(":memory:");
    upsertOrder(fresh, order({ id: 1, createdOn: "2025-06-05T02:00:00.000Z", orderTotal: 100, ...ALICE, ...CITY }), [
      // 100 / 1.1 - 40 = 50.9090..., must round to 50.91
      item({ id: 11, orderId: 1, lineTotal: 100, cogsEx: 40, ...P100 }),
    ]);
    const [row] = runReport(fresh, { fromTs: FROM, toTs: TO, by: ["product"] });
    expect(row).toMatchObject({ revenue: 100, gross_profit_ex: 50.91 });
  });
});
