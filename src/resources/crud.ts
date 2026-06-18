import type { AuditRecord } from "../core/audit";
import type { QueryValue, RexClient } from "../core/client";
import { computeDiff } from "../core/diff";
import { ValidationError, WriteGatedError } from "../core/errors";
import { classifyChanged } from "../core/fields";
import { fetchPage, type ListEnvelope, paginate } from "../core/paginate";

const NO_PRICE_FIELDS: ReadonlySet<string> = new Set();

/** Describes one Retail Express resource for the generic CRUD engine. */
export interface ResourceConfig {
  /** Singular name, used in audit records and errors (e.g. "product"). */
  resource: string;
  /** API path segment (e.g. "products"). */
  path: string;
  /** Fields gated behind --allow-price. Empty for non-priced resources. */
  priceFields?: ReadonlySet<string>;
}

export interface ListArgs {
  page?: number;
  pageSize?: number;
  query?: Record<string, QueryValue>;
}

export interface WriteOptions {
  dryRun?: boolean;
  allowPrice?: boolean;
  profile: string;
  now?: () => string;
  audit?: (record: AuditRecord) => void;
}

export interface WriteResult {
  id: number | string | null;
  action: "create" | "update" | "disable" | "enable";
  changed: string[];
  dryRun: boolean;
  skipped?: boolean;
  priceGated?: string[];
  diff?: Record<string, unknown>;
  result?: unknown;
}

// ---- reads -----------------------------------------------------------------

export function listResource<T>(
  client: RexClient,
  path: string,
  args: ListArgs = {},
): Promise<ListEnvelope<T>> {
  return fetchPage<T>(client, path, { page: args.page, pageSize: args.pageSize, query: args.query });
}

export function streamResource<T>(
  client: RexClient,
  path: string,
  args: ListArgs = {},
): AsyncGenerator<T> {
  return paginate<T>(client, path, { pageSize: args.pageSize, query: args.query });
}

export function getResource<T>(client: RexClient, path: string, id: number | string): Promise<T> {
  return client.get<T>(`${path}/${id}`);
}

// ---- write helpers ---------------------------------------------------------

function nowIso(opts: WriteOptions): string {
  return opts.now ? opts.now() : new Date().toISOString();
}

/** Retail Express ids are integers; coerce numeric strings so results/URLs are clean. */
export function coerceId(id: number | string): number | string {
  return typeof id === "string" && /^\d+$/.test(id) ? Number(id) : id;
}

function extractId(config: ResourceConfig, record: Record<string, unknown>): number | string {
  const id = record.id;
  if (typeof id === "number") return id;
  if (typeof id === "string" && id.length > 0) return coerceId(id);
  throw new ValidationError(`Each ${config.resource} update needs an \`id\`.`, { details: { record } });
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

// ---- writes ----------------------------------------------------------------

export async function updateResource(
  client: RexClient,
  config: ResourceConfig,
  desired: Record<string, unknown>,
  opts: WriteOptions,
): Promise<WriteResult> {
  const priceFields = config.priceFields ?? NO_PRICE_FIELDS;
  const id = extractId(config, desired);
  const current = await getResource<Record<string, unknown>>(client, config.path, id);
  const { changed, changedKeys, touchedPriceFields } = computeDiff(current, omitId(desired), priceFields);

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

  const result = await client.request("PUT", `${config.path}/${id}`, { body: changed });
  opts.audit?.({
    ts: nowIso(opts),
    profile: opts.profile,
    action: "update",
    resource: config.resource,
    id,
    changed: changedKeys,
    before: pick(current, changedKeys),
    after: changed,
  });
  return { id, action: "update", changed: changedKeys, dryRun: false, result };
}

export async function createResource(
  client: RexClient,
  config: ResourceConfig,
  body: Record<string, unknown>,
  opts: WriteOptions,
): Promise<WriteResult> {
  const { price } = classifyChanged(Object.keys(body), config.priceFields ?? NO_PRICE_FIELDS);
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

  const result = (await client.request<Record<string, unknown>>("POST", config.path, { body })) ?? {};
  const id = typeof result.id === "number" || typeof result.id === "string" ? result.id : null;
  opts.audit?.({
    ts: nowIso(opts),
    profile: opts.profile,
    action: "create",
    resource: config.resource,
    id: id ?? undefined,
    changed: Object.keys(body),
    after: body,
  });
  return { id, action: "create", changed: Object.keys(body), dryRun: false, result };
}

export async function disableResource(
  client: RexClient,
  config: ResourceConfig,
  rawId: number | string,
  opts: WriteOptions,
): Promise<WriteResult> {
  const id = coerceId(rawId);
  if (opts.dryRun) {
    return { id, action: "disable", changed: ["disabled"], dryRun: true };
  }
  const result = await client.request("DELETE", `${config.path}/${id}`);
  opts.audit?.({
    ts: nowIso(opts),
    profile: opts.profile,
    action: "disable",
    resource: config.resource,
    id,
    changed: ["disabled"],
  });
  return { id, action: "disable", changed: ["disabled"], dryRun: false, result };
}
