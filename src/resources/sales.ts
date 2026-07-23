import type { Database } from "bun:sqlite";
import type { QueryValue, RexClient } from "../core/client";
import { fetchPage } from "../core/paginate";
import { adelaideDayMonth } from "../core/period";
import {
  getMeta,
  type OrderItemRow,
  type OrderRow,
  setMeta,
  upsertOrder,
} from "../core/salesdb";

/**
 * Sync engine for the local sales mirror (ADR 0007). The REST API cannot
 * aggregate or date-filter, so we stream `GET orders?include_items=true` into
 * SQLite: a resumable page-by-page full sync the first time, then incremental
 * catch-up via `modified_since` from a watermark (max `modified_on` seen).
 */

/** Re-fetch this far behind the watermark so clock skew can't drop edits. */
const WATERMARK_OVERLAP_MS = 24 * 60 * 60 * 1000;

const PROGRESS_EVERY_PAGES = 25;

// ---- API shapes (verified live; only the fields the mirror stores) ---------

interface ApiOrder {
  id: number;
  created_on: string;
  modified_on: string;
  order_status?: { id: number; status: string | null } | null;
  sales_person?: { id: number; first_name?: string | null; surname?: string | null } | null;
  outlet?: { id: number; name?: string | null } | null;
  order_total: number;
  freight_total?: number | null;
  customer?: { id: number } | null;
  order_items?: ApiOrderItem[] | null;
}

interface ApiOrderItem {
  id: number;
  order_item_type?: string | null;
  product?: {
    id: number;
    short_description?: string | null;
    product_type?: { id: number; name?: string | null } | null;
  } | null;
  quantity_ordered?: number | null;
  sell_price?: number | null;
  /** Line-level inc-GST total (sell_price * quantity — verified live). */
  order_item_total?: number | null;
  order_item_discount_total?: number | null;
  tax_rate?: number | null;
  /** Per-UNIT ex-GST cost (equals supplier_buy_ex on multi-qty lines — verified live). */
  cogs_ex?: number | null;
}

// ---- mapping ---------------------------------------------------------------

function mapOrder(raw: ApiOrder): { order: OrderRow; items: OrderItemRow[] } {
  const buckets = adelaideDayMonth(raw.created_on);
  const sp = raw.sales_person ?? null;
  const spName = sp ? `${sp.first_name ?? ""} ${sp.surname ?? ""}`.trim() : "";
  const order: OrderRow = {
    id: raw.id,
    createdOn: raw.created_on,
    createdTs: Date.parse(raw.created_on),
    dayLocal: buckets.day,
    monthLocal: buckets.month,
    modifiedOn: raw.modified_on,
    statusId: raw.order_status?.id ?? null,
    statusName: raw.order_status?.status ?? null,
    salespersonId: sp?.id ?? null,
    salespersonName: spName.length > 0 ? spName : null,
    outletId: raw.outlet?.id ?? null,
    outletName: raw.outlet?.name ?? null,
    orderTotal: raw.order_total,
    freightTotal: raw.freight_total ?? 0,
    customerId: raw.customer?.id ?? null,
  };
  const items: OrderItemRow[] = (raw.order_items ?? []).map((item) => ({
    id: item.id,
    orderId: raw.id,
    productId: item.product?.id ?? null,
    productName: item.product?.short_description ?? null,
    productTypeId: item.product?.product_type?.id ?? null,
    productTypeName: item.product?.product_type?.name ?? null,
    itemType: item.order_item_type ?? null,
    quantity: item.quantity_ordered ?? 0,
    sellPrice: item.sell_price ?? 0,
    lineTotal: item.order_item_total ?? 0,
    discountTotal: item.order_item_discount_total ?? 0,
    taxRate: item.tax_rate ?? 0,
    cogsEx: item.cogs_ex ?? 0,
  }));
  return { order, items };
}

// ---- sync ------------------------------------------------------------------

export interface SyncResult {
  fullSync: boolean;
  ordersSynced: number;
  pages: number;
  watermark: string | null;
  resumedFromPage?: number;
  durationMs: number;
  /** Status tallies from this run — empirical audit of the "Sale" definition. */
  statuses: Record<string, number>;
  negativeTotals: number;
}

export interface SyncOptions {
  /** Force a full re-stream even when a watermark exists. */
  full?: boolean;
  onProgress?: (msg: string) => void;
  now?: () => Date;
}

/**
 * Mirror orders into the sales db. Full mode writes `full_sync_page` after
 * every committed page so an interrupted run resumes from where it stopped
 * (a leftover cursor always forces full mode, --full or not); on completion
 * the cursor is cleared and `watermark` is set to the max `modified_on` across
 * the whole table, so pages committed by an interrupted predecessor count too.
 * Incremental mode filters by `modified_since` = watermark − 24h overlap.
 * `last_synced_at` is stamped on every successful run.
 */
export async function syncSales(
  client: RexClient,
  db: Database,
  opts: SyncOptions = {},
): Promise<SyncResult> {
  const now = opts.now ?? (() => new Date());
  const started = now().getTime();

  const priorWatermark = getMeta(db, "watermark");
  const cursor = getMeta(db, "full_sync_page");
  const fullSync = opts.full === true || priorWatermark === null || cursor !== null;

  const query: Record<string, QueryValue> = { include_items: true };
  let page = 1;
  let resumedFromPage: number | undefined;
  if (fullSync) {
    if (cursor !== null) {
      resumedFromPage = Number(cursor) + 1;
      page = resumedFromPage;
    }
  } else {
    query.modified_since = new Date(Date.parse(priorWatermark!) - WATERMARK_OVERLAP_MS).toISOString();
  }

  let ordersSynced = 0;
  let pages = 0;
  let negativeTotals = 0;
  const statuses: Record<string, number> = {};
  let maxModified = priorWatermark;
  let maxModifiedTs = priorWatermark === null ? Number.NEGATIVE_INFINITY : Date.parse(priorWatermark);

  for (;;) {
    const { nodes, pageInfo } = await fetchPage<ApiOrder>(client, "orders", { page, query });

    // One transaction per page: the rows and the resume cursor commit together.
    db.transaction(() => {
      for (const raw of nodes) {
        const mapped = mapOrder(raw);
        upsertOrder(db, mapped.order, mapped.items);
        const status = mapped.order.statusName ?? "Unknown";
        statuses[status] = (statuses[status] ?? 0) + 1;
        if (mapped.order.orderTotal < 0) negativeTotals += 1;
        const ts = Date.parse(raw.modified_on);
        if (ts > maxModifiedTs) {
          maxModifiedTs = ts;
          maxModified = raw.modified_on;
        }
      }
      if (fullSync) setMeta(db, "full_sync_page", String(page));
    })();

    ordersSynced += nodes.length;
    pages += 1;

    const totalPages =
      pageInfo.total > 0 && pageInfo.pageSize > 0
        ? Math.max(page, Math.ceil(pageInfo.total / pageInfo.pageSize))
        : page;
    if (opts.onProgress && pages % PROGRESS_EVERY_PAGES === 0) {
      opts.onProgress(`page ${page}/${totalPages} (${Math.round((page / totalPages) * 100)}%)`);
    }

    if (nodes.length === 0 || nodes.length < pageInfo.pageSize || page >= totalPages) break;
    page += 1;
  }

  if (fullSync) {
    db.query("DELETE FROM meta WHERE key = 'full_sync_page'").run();
    // A resumed run never saw the pages committed before the crash (and a run
    // that resumes past the final page sees none at all), so floor the
    // watermark at the table-wide max rather than trusting this run's pages.
    const dbMax = (
      db.query("SELECT MAX(modified_on) AS m FROM orders").get() as { m: string | null }
    ).m;
    if (dbMax !== null && Date.parse(dbMax) > maxModifiedTs) {
      maxModifiedTs = Date.parse(dbMax);
      maxModified = dbMax;
    }
  }
  if (maxModified !== null) setMeta(db, "watermark", maxModified);
  setMeta(db, "last_synced_at", now().toISOString());

  return {
    fullSync,
    ordersSynced,
    pages,
    watermark: maxModified,
    ...(resumedFromPage !== undefined ? { resumedFromPage } : {}),
    durationMs: now().getTime() - started,
    statuses,
    negativeTotals,
  };
}
