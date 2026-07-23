import type { Database } from "bun:sqlite";
import { chmodSync, closeSync, mkdirSync, openSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { ValidationError } from "./errors";
import { stateDir } from "./paths";
import { validateSafeProfileName } from "./validation";

/**
 * `bun:sqlite` is loaded lazily: `bun build --target node` keeps the `bun:`
 * specifier, which Node cannot import at module load — an eager import would
 * break every command (even `rex --help`) in the published Node build. Under
 * Node the failure is deferred to first sales-cache use, with a clear message.
 */
let sqlite: typeof import("bun:sqlite") | undefined;
function loadSqlite(): typeof import("bun:sqlite") {
  if (!sqlite) {
    try {
      sqlite = createRequire(import.meta.url)("bun:sqlite") as typeof import("bun:sqlite");
    } catch (cause) {
      throw new Error("The sales cache needs the Bun runtime (bun:sqlite). Re-run rex with Bun.", {
        cause,
      });
    }
  }
  return sqlite;
}

/** Local sales mirror for a profile: `<stateDir>/sales.<profile>.db`. */
export function salesDbFile(profile: string): string {
  return join(stateDir(), `sales.${validateSafeProfileName(profile)}.db`);
}

// ---- schema ----------------------------------------------------------------

const SCHEMA = `
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY,
  created_on TEXT,
  created_ts INTEGER,
  day_local TEXT,
  month_local TEXT,
  modified_on TEXT,
  status_id INTEGER,
  status_name TEXT,
  salesperson_id INTEGER,
  salesperson_name TEXT,
  outlet_id INTEGER,
  outlet_name TEXT,
  order_total REAL,
  freight_total REAL,
  customer_id INTEGER
);
CREATE TABLE IF NOT EXISTS order_items (
  id INTEGER PRIMARY KEY,
  order_id INTEGER,
  product_id INTEGER,
  product_name TEXT,
  product_type_id INTEGER,
  product_type_name TEXT,
  item_type TEXT,
  quantity REAL,
  sell_price REAL,
  line_total REAL,
  discount_total REAL,
  tax_rate REAL,
  cogs_ex REAL
);
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT
);
CREATE INDEX IF NOT EXISTS idx_orders_created_ts ON orders (created_ts);
CREATE INDEX IF NOT EXISTS idx_orders_salesperson_id ON orders (salesperson_id);
CREATE INDEX IF NOT EXISTS idx_orders_outlet_id ON orders (outlet_id);
CREATE INDEX IF NOT EXISTS idx_order_items_order_id ON order_items (order_id);
CREATE INDEX IF NOT EXISTS idx_order_items_product_id ON order_items (product_id);
`;

/**
 * Open (creating if needed) a sales db. Applies the schema idempotently,
 * switches to WAL, mkdirs the parent directory, and stamps meta
 * `schema_version` so future migrations have something to branch on.
 */
export function openSalesDb(path: string): Database {
  // Customer/sales data: owner-only, like config.toml and the token cache.
  // The file is created 0o600 BEFORE SQLite opens it (no umask-default
  // window); chmod covers pre-existing files and any -wal/-shm survivors of
  // an earlier open. New sidecars inherit the main file's mode.
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
    closeSync(openSync(path, "a", 0o600));
    chmodSync(path, 0o600);
    for (const sidecar of [`${path}-wal`, `${path}-shm`]) {
      try {
        chmodSync(sidecar, 0o600);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
    }
  }
  const db = new (loadSqlite().Database)(path, { create: true });
  try {
    db.exec("PRAGMA journal_mode = WAL;");
    // A concurrent sync/report pair should wait briefly, not die on SQLITE_BUSY.
    db.exec("PRAGMA busy_timeout = 5000;");
    db.exec(SCHEMA);
    setMeta(db, "schema_version", "1");
  } catch (err) {
    db.close();
    throw err;
  }
  return db;
}

// ---- rows ------------------------------------------------------------------

/** One order header, denormalised (status/salesperson/outlet names inline). */
export interface OrderRow {
  id: number;
  createdOn: string;
  /** Unix ms of `createdOn`; all range filters run against this. */
  createdTs: number;
  /** Store-local (Australia/Adelaide) 'YYYY-MM-DD' / 'YYYY-MM' bucket keys. */
  dayLocal: string;
  monthLocal: string;
  modifiedOn: string;
  statusId: number | null;
  statusName: string | null;
  salespersonId: number | null;
  salespersonName: string | null;
  outletId: number | null;
  outletName: string | null;
  /** Inc-GST, freight included — the headline "Sale" value. */
  orderTotal: number;
  freightTotal: number;
  customerId: number | null;
}

export interface OrderItemRow {
  id: number;
  orderId: number;
  productId: number | null;
  productName: string | null;
  productTypeId: number | null;
  productTypeName: string | null;
  /** null / 'Sale' / 'Return' / other (freight, fees). Returns carry negative quantity. */
  itemType: string | null;
  quantity: number;
  sellPrice: number;
  /** Inc-GST line total. */
  lineTotal: number;
  discountTotal: number;
  taxRate: number;
  cogsEx: number;
}

/**
 * Upsert one order and its items in a single transaction: replace the header,
 * delete its existing items, re-insert. Idempotent by construction — sync
 * windows overlap, so the same order is routinely written more than once.
 */
export function upsertOrder(db: Database, order: OrderRow, items: OrderItemRow[]): void {
  if (!Number.isFinite(order.createdTs)) {
    // A NaN created_ts row would silently drop out of every range filter.
    throw new ValidationError(`order ${order.id} has an unparseable created_on`, {
      details: { orderId: order.id, createdOn: order.createdOn },
    });
  }
  for (const item of items) {
    // A mismatched line would survive this order's delete-and-reinsert and
    // silently corrupt another order's aggregates.
    if (item.orderId !== order.id) {
      throw new ValidationError(`item ${item.id} belongs to order ${item.orderId}, not ${order.id}`, {
        details: { orderId: order.id, itemId: item.id, itemOrderId: item.orderId },
      });
    }
  }
  const insertHeader = db.query(
    `INSERT OR REPLACE INTO orders (
       id, created_on, created_ts, day_local, month_local, modified_on,
       status_id, status_name, salesperson_id, salesperson_name,
       outlet_id, outlet_name, order_total, freight_total, customer_id
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const deleteItems = db.query("DELETE FROM order_items WHERE order_id = ?");
  const insertItem = db.query(
    `INSERT INTO order_items (
       id, order_id, product_id, product_name, product_type_id, product_type_name,
       item_type, quantity, sell_price, line_total, discount_total, tax_rate, cogs_ex
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  db.transaction(() => {
    insertHeader.run(
      order.id, order.createdOn, order.createdTs, order.dayLocal, order.monthLocal,
      order.modifiedOn, order.statusId, order.statusName, order.salespersonId,
      order.salespersonName, order.outletId, order.outletName, order.orderTotal,
      order.freightTotal, order.customerId,
    );
    deleteItems.run(order.id);
    for (const item of items) {
      insertItem.run(
        item.id, item.orderId, item.productId, item.productName, item.productTypeId,
        item.productTypeName, item.itemType, item.quantity, item.sellPrice,
        item.lineTotal, item.discountTotal, item.taxRate, item.cogsEx,
      );
    }
  })();
}

// ---- meta ------------------------------------------------------------------

export function getMeta(db: Database, key: string): string | null {
  const row = db.query("SELECT value FROM meta WHERE key = ?").get(key) as
    | { value: string | null }
    | null;
  return row?.value ?? null;
}

export function setMeta(db: Database, key: string, value: string): void {
  db.query(
    "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
  ).run(key, value);
}

// ---- reporting -------------------------------------------------------------

/** Canonical allow-lists; the CLI derives its flag validation from these. */
export const DIMENSION_KEYS = ["salesperson", "outlet", "product", "month", "day"] as const;
export const SORT_KEYS = ["revenue", "units", "profit"] as const;
export type Dimension = (typeof DIMENSION_KEYS)[number];
export type SortKey = (typeof SORT_KEYS)[number];

export interface ReportOptions {
  /** Half-open [fromTs, toTs) range in unix ms against orders.created_ts. */
  fromTs: number;
  toTs: number;
  by: Dimension[];
  sort?: SortKey;
  top?: number;
  /** Restrict to one product's lines (forces line-level aggregation). */
  productId?: number;
}

/**
 * Fixed dimension → SQL lookup. Report SQL is assembled ONLY from these
 * strings plus bound parameters — user input never reaches the SQL text.
 * `o` is the orders header, `i` an order_items line (product only appears in
 * item mode, so `i` is always in scope for it).
 */
// Group by stable IDs only: denormalised names are display fields (via MAX so
// they aggregate), else a renamed salesperson/product would split into one row
// per historical name, since old order rows keep the name they were synced with.
const DIMENSIONS: Record<Dimension, { select: string[]; group: string[] }> = {
  salesperson: {
    select: [
      "o.salesperson_id AS salesperson_id",
      "COALESCE(MAX(o.salesperson_name), 'Unknown') AS salesperson_name",
    ],
    group: ["o.salesperson_id"],
  },
  outlet: {
    select: ["o.outlet_id AS outlet_id", "MAX(o.outlet_name) AS outlet_name"],
    group: ["o.outlet_id"],
  },
  product: {
    select: [
      "i.product_id AS product_id",
      "MAX(i.product_name) AS product_name",
      "MAX(i.product_type_name) AS product_type_name",
    ],
    group: ["i.product_id"],
  },
  month: { select: ["o.month_local AS month"], group: ["o.month_local"] },
  day: { select: ["o.day_local AS day"], group: ["o.day_local"] },
};

const SORTS: Record<SortKey, string> = {
  revenue: "revenue DESC",
  units: "units DESC",
  profit: "gross_profit_ex DESC",
};

/**
 * Sales = committed orders only. Cancelled is not revenue; a Quote was never
 * an order; Incomplete never finished being written (live audit: together
 * ~5-8% of raw non-Cancelled totals). Awaiting Payment DOES count — a written
 * order on the accrual (created_on) basis. NULL status counts as a sale.
 */
function isSale(t: string): string {
  return `COALESCE(${t}.status_name, '') NOT IN ('Cancelled', 'Quote', 'Incomplete')`;
}
const IS_SALE = isSale("o");

/**
 * Per-line gross profit: ex-GST revenue minus COGS. ASSUMPTION: `cogs_ex` is
 * recorded per unit, hence `* quantity`. If live data shows it is already
 * line-level, delete the `* quantity` — this is the only place the formula lives.
 */
function profitExpr(t: string): string {
  return `(${t}.line_total / (1.0 + ${t}.tax_rate) - ${t}.cogs_ex * ${t}.quantity)`;
}

/**
 * Only sale/return lines carry product revenue, units, and profit; other line
 * types (freight, fees) are excluded from item-level aggregation entirely,
 * matching the documented "line totals exclude freight" semantics. Returns
 * carry negative quantity/total, so they net off.
 */
function saleLine(t: string): string {
  return `(${t}.item_type IS NULL OR ${t}.item_type IN ('Sale', 'Return'))`;
}

/** Round money at the output edge only; aggregation runs on raw values. */
function money(value: unknown): number {
  return Math.round(Number(value ?? 0) * 100) / 100;
}

/**
 * Aggregate the mirror per the canonical sales semantics: Cancelled headers
 * excluded, [fromTs, toTs) on created_ts. Product-grouped (or productId-
 * filtered) reports sum line totals; every other grouping sums header
 * order_total (freight lives on the header) with units/profit joined in from
 * a per-order items aggregate. Rows carry dimension columns plus `revenue`
 * (headline, default sort), `units`, `gross_profit_ex`, `orders`.
 */
export function runReport(db: Database, opts: ReportOptions): Record<string, unknown>[] {
  const itemMode = opts.by.includes("product") || opts.productId !== undefined;
  const dims = opts.by.map((d) => {
    const dim = DIMENSIONS[d];
    if (!dim) throw new ValidationError(`unknown report dimension "${d}"`);
    return dim;
  });
  if (opts.top !== undefined && (!Number.isInteger(opts.top) || opts.top <= 0)) {
    // SQLite treats LIMIT <= 0 as unbounded — reject rather than surprise.
    throw new ValidationError(`top must be a positive integer, got ${opts.top}`);
  }
  const selects = dims.flatMap((d) => d.select);
  const groups = dims.flatMap((d) => d.group);
  let params: number[] = [opts.fromTs, opts.toTs];

  let sql: string;
  if (itemMode) {
    let where = `${IS_SALE} AND ${saleLine("i")} AND o.created_ts >= ? AND o.created_ts < ?`;
    if (opts.productId !== undefined) {
      where += " AND i.product_id = ?";
      params.push(opts.productId);
    }
    const measures = [
      "SUM(i.line_total) AS revenue",
      "SUM(i.quantity) AS units",
      `SUM(${profitExpr("i")}) AS gross_profit_ex`,
      "COUNT(DISTINCT i.order_id) AS orders",
    ];
    sql = `SELECT ${[...selects, ...measures].join(", ")}
      FROM order_items i
      JOIN orders o ON o.id = i.order_id
      WHERE ${where}`;
  } else {
    const measures = [
      "SUM(o.order_total) AS revenue",
      "SUM(COALESCE(x.units, 0)) AS units",
      "SUM(COALESCE(x.gross_profit_ex, 0)) AS gross_profit_ex",
      "COUNT(*) AS orders",
    ];
    // The subquery repeats the sale/range filter so it aggregates only the
    // period's lines, not the whole mirror. Its placeholders bind first.
    sql = `SELECT ${[...selects, ...measures].join(", ")}
      FROM orders o
      LEFT JOIN (
        SELECT i.order_id AS order_id,
               SUM(i.quantity) AS units,
               SUM(${profitExpr("i")}) AS gross_profit_ex
        FROM order_items i
        JOIN orders oi ON oi.id = i.order_id
        WHERE ${isSale("oi")} AND ${saleLine("i")} AND oi.created_ts >= ? AND oi.created_ts < ?
        GROUP BY i.order_id
      ) x ON x.order_id = o.id
      WHERE ${IS_SALE} AND o.created_ts >= ? AND o.created_ts < ?`;
    // Subquery placeholders bind first, then the outer WHERE's pair.
    params = [opts.fromTs, opts.toTs, opts.fromTs, opts.toTs];
  }

  const orderBy = SORTS[opts.sort ?? "revenue"];
  if (!orderBy) throw new ValidationError(`unknown sort key "${opts.sort}"`);
  if (groups.length > 0) sql += ` GROUP BY ${groups.join(", ")}`;
  sql += ` ORDER BY ${orderBy}`;
  if (opts.top !== undefined) {
    sql += " LIMIT ?";
    params.push(opts.top);
  }

  const rows = db.query(sql).all(...params) as Record<string, unknown>[];
  return rows.map((row) => ({
    ...row,
    revenue: money(row.revenue),
    units: Number(row.units ?? 0),
    gross_profit_ex: money(row.gross_profit_ex),
    orders: Number(row.orders ?? 0),
  }));
}

/** Cheap freshness/size probe for `sync status`-style output. */
export function dbSummary(db: Database): {
  orders: number;
  items: number;
  minCreatedOn: string | null;
  maxCreatedOn: string | null;
} {
  const row = db.query(
    `SELECT (SELECT COUNT(*) FROM orders) AS orders,
            (SELECT COUNT(*) FROM order_items) AS items,
            (SELECT MIN(created_on) FROM orders) AS min_created_on,
            (SELECT MAX(created_on) FROM orders) AS max_created_on`,
  ).get() as {
    orders: number;
    items: number;
    min_created_on: string | null;
    max_created_on: string | null;
  };
  return {
    orders: row.orders,
    items: row.items,
    minCreatedOn: row.min_created_on,
    maxCreatedOn: row.max_created_on,
  };
}
