import type { QueryValue, RexClient } from "../core/client";
import { computeDiff } from "../core/diff";
import { ValidationError, WriteGatedError } from "../core/errors";
import { classifyChanged } from "../core/fields";
import { fetchPage, type ListEnvelope, paginate } from "../core/paginate";
import type { AuditRecord } from "../core/audit";

export interface Product {
  id: number;
  short_description?: string;
  [key: string]: unknown;
}

export interface ListArgs {
  page?: number;
  pageSize?: number;
  query?: Record<string, QueryValue>;
}

export function listProducts(client: RexClient, args: ListArgs = {}): Promise<ListEnvelope<Product>> {
  return fetchPage<Product>(client, "products", {
    page: args.page,
    pageSize: args.pageSize,
    query: args.query,
  });
}

export function streamProducts(client: RexClient, args: ListArgs = {}): AsyncGenerator<Product> {
  return paginate<Product>(client, "products", { pageSize: args.pageSize, query: args.query });
}

export function getProduct(client: RexClient, id: number | string): Promise<Product> {
  return client.get<Product>(`products/${id}`);
}

// ---- writes ----------------------------------------------------------------

export interface WriteOptions {
  dryRun?: boolean;
  allowPrice?: boolean;
  profile: string;
  now?: () => string;
  audit?: (record: AuditRecord) => void;
}

export interface WriteResult {
  id: number | null;
  action: "create" | "update" | "disable" | "enable";
  changed: string[];
  dryRun: boolean;
  skipped?: boolean;
  priceGated?: string[];
  diff?: Record<string, unknown>;
  result?: unknown;
}

function nowIso(opts: WriteOptions): string {
  return opts.now ? opts.now() : new Date().toISOString();
}

function extractId(record: Record<string, unknown>): number {
  const id = record.id;
  if (typeof id === "number") return id;
  if (typeof id === "string" && /^\d+$/.test(id)) return Number(id);
  throw new ValidationError("Each product update needs a numeric `id`.", {
    details: { record },
  });
}

function omitId(record: Record<string, unknown>): Record<string, unknown> {
  const { id: _id, ...rest } = record;
  return rest;
}

function pick(obj: Record<string, unknown> | undefined, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) out[key] = obj?.[key];
  return out;
}

/**
 * Update one product: re-fetch current state, diff, and PUT only changed fields.
 * Price fields are gated behind allowPrice. In dry-run nothing is sent and
 * gated price changes are reported rather than thrown.
 */
export async function updateProduct(
  client: RexClient,
  desired: Record<string, unknown>,
  opts: WriteOptions,
): Promise<WriteResult> {
  const id = extractId(desired);
  const current = await getProduct(client, id);
  const { changed, changedKeys, touchedPriceFields } = computeDiff(current, omitId(desired));

  if (changedKeys.length === 0) {
    return { id, action: "update", changed: [], dryRun: Boolean(opts.dryRun), skipped: true };
  }

  const gated = touchedPriceFields.length > 0 && !opts.allowPrice;

  if (opts.dryRun) {
    return {
      id,
      action: "update",
      changed: changedKeys,
      dryRun: true,
      diff: changed,
      ...(gated ? { priceGated: touchedPriceFields } : {}),
    };
  }

  if (gated) {
    throw new WriteGatedError(
      `Refusing to write price field(s) without --allow-price: ${touchedPriceFields.join(", ")}`,
      { details: { id, priceFields: touchedPriceFields } },
    );
  }

  const result = await client.request("PUT", `products/${id}`, { body: changed });
  opts.audit?.({
    ts: nowIso(opts),
    profile: opts.profile,
    action: "update",
    resource: "product",
    id,
    changed: changedKeys,
    before: pick(current, changedKeys),
    after: changed,
  });
  return { id, action: "update", changed: changedKeys, dryRun: false, result };
}

/** Create a product. Price fields in the body are gated behind allowPrice. */
export async function createProduct(
  client: RexClient,
  body: Record<string, unknown>,
  opts: WriteOptions,
): Promise<WriteResult> {
  const { price } = classifyChanged(Object.keys(body));
  const gated = price.length > 0 && !opts.allowPrice;

  if (opts.dryRun) {
    return {
      id: null,
      action: "create",
      changed: Object.keys(body),
      dryRun: true,
      diff: body,
      ...(gated ? { priceGated: price } : {}),
    };
  }
  if (gated) {
    throw new WriteGatedError(
      `Refusing to create with price field(s) without --allow-price: ${price.join(", ")}`,
      { details: { priceFields: price } },
    );
  }

  const result = (await client.request<Product>("POST", "products", { body })) as Product;
  const id = typeof result?.id === "number" ? result.id : null;
  opts.audit?.({
    ts: nowIso(opts),
    profile: opts.profile,
    action: "create",
    resource: "product",
    id: id ?? undefined,
    changed: Object.keys(body),
    after: body,
  });
  return { id, action: "create", changed: Object.keys(body), dryRun: false, result };
}

/** Soft-disable a product (DELETE = hide from POS/reports/ecommerce, NOT a hard delete). */
export async function disableProduct(
  client: RexClient,
  id: number | string,
  opts: WriteOptions,
): Promise<WriteResult> {
  const numId = typeof id === "string" && /^\d+$/.test(id) ? Number(id) : (id as number);
  if (opts.dryRun) {
    return { id: numId, action: "disable", changed: ["disabled"], dryRun: true };
  }
  const result = await client.request("DELETE", `products/${numId}`);
  opts.audit?.({
    ts: nowIso(opts),
    profile: opts.profile,
    action: "disable",
    resource: "product",
    id: numId,
    changed: ["disabled"],
  });
  return { id: numId, action: "disable", changed: ["disabled"], dryRun: false, result };
}
