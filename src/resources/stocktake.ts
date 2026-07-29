import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { CredentialStatus } from "../core/capabilities";
import type { RexClient } from "../core/client";
import { NotFoundError, ValidationError } from "../core/errors";
import { stocktakeSessionFile } from "../core/paths";
import type { ListEnvelope } from "../core/paginate";
import { getProduct, listProducts, type Product } from "./products";
import { getResource, listResource } from "./crud";

/**
 * `wms` sessions are bound to a WMS credential set at `begin` and can be
 * submitted. `local` sessions are opened without WMS credentials: they count,
 * price variances against live stock, and export a worksheet, but can never
 * reach Retail Express. The mode is fixed at `begin` so a session can't quietly
 * change meaning halfway through a count.
 */
export type StocktakeMode = "wms" | "local";

export interface StocktakeSession {
  id: string;
  profile: string;
  /** Present only on `wms` sessions — identifies the credentials in force at `begin`. */
  wmsFingerprint?: string;
  /** Absent on sessions written before local mode existed; those are `wms`. */
  mode?: StocktakeMode;
  outletId: number;
  outletName?: string;
  /** Required to submit, so optional on `local` sessions. */
  userId?: number;
  createdAt: string;
  updatedAt: string;
  lines: StocktakeLine[];
}

/** Sessions written before local mode existed always required WMS credentials. */
export function sessionMode(session: StocktakeSession): StocktakeMode {
  return session.mode ?? "wms";
}

export interface StocktakeLine {
  lineId: string;
  query: string;
  productId: number;
  description?: string;
  sku?: string;
  counted: number;
  currentStock: number;
  variance: number;
  addedAt: string;
  updatedAt: string;
}

export interface OutletRef {
  id: number;
  name?: string;
}

export interface ResolvedProduct {
  id: number;
  description?: string;
  sku?: string;
  raw: Product;
}

const SCAN_FIELDS = [
  "sku",
  "SKU",
  "barcode",
  "Barcode",
  "supplier_sku",
  "supplierSku",
  "SupplierSKU",
  "manufacturer_sku",
  "manufacturerSku",
  "ManufacturerSKU",
] as const;

export interface InventorySnapshot {
  outletId: number;
  currentStock: number;
  raw: Record<string, unknown>;
}

export function sessionPath(profile: string): string {
  return stocktakeSessionFile(profile);
}

export function sessionStorageKey(profile: { name: string; apiKey: string }): string {
  const digest = createHash("sha256").update(profile.apiKey).digest("hex").slice(0, 12);
  return `${profile.name}-api-${digest}`;
}

export function loadSession(profile: string): StocktakeSession {
  const path = sessionPath(profile);
  if (!existsSync(path)) {
    throw new ValidationError("No active stocktake session.", {
      details: { hint: "Run `rex stocktake begin --outlet <id|name> --user-id <id>` first." },
    });
  }
  try {
    return JSON.parse(readFileSync(path, "utf8")) as StocktakeSession;
  } catch (err) {
    throw new ValidationError("Stocktake session file is corrupted.", {
      cause: err,
      details: { path, hint: "Run `rex stocktake abort` to clear it, then start over." },
    });
  }
}

export function maybeLoadSession(profile: string): StocktakeSession | undefined {
  const path = sessionPath(profile);
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as StocktakeSession;
  } catch {
    return undefined;
  }
}

export function sessionExists(profile: string): boolean {
  return existsSync(sessionPath(profile));
}

export function saveSession(session: StocktakeSession, storageKey: string): void {
  const path = sessionPath(storageKey);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(session, null, 2), { mode: 0o600 });
  renameSync(tmp, path);
}

export function clearSession(profile: string): void {
  rmSync(sessionPath(profile), { force: true });
}

export function createSession(input: {
  profile: string;
  wmsFingerprint?: string;
  mode?: StocktakeMode;
  outlet: OutletRef;
  userId?: number;
  now?: () => string;
}): StocktakeSession {
  const now = input.now?.() ?? new Date().toISOString();
  return {
    id: `${input.profile}-${Date.now().toString(36)}`,
    profile: input.profile,
    ...(input.wmsFingerprint ? { wmsFingerprint: input.wmsFingerprint } : {}),
    mode: input.mode ?? "wms",
    outletId: input.outlet.id,
    outletName: input.outlet.name,
    ...(input.userId === undefined ? {} : { userId: input.userId }),
    createdAt: now,
    updatedAt: now,
    lines: [],
  };
}

export function upsertLine(
  session: StocktakeSession,
  input: {
    query: string;
    product: ResolvedProduct;
    counted: number;
    currentStock: number;
    now?: () => string;
  },
): { session: StocktakeSession; line: StocktakeLine; updated: boolean } {
  const now = input.now?.() ?? new Date().toISOString();
  const variance = input.counted - input.currentStock;
  const next: StocktakeLine = {
    lineId: String(input.product.id),
    query: input.query,
    productId: input.product.id,
    description: input.product.description,
    sku: input.product.sku,
    counted: input.counted,
    currentStock: input.currentStock,
    variance,
    addedAt: now,
    updatedAt: now,
  };
  const idx = session.lines.findIndex((line) => line.productId === input.product.id);
  if (idx === -1) {
    session.lines.push(next);
    session.updatedAt = now;
    return { session, line: next, updated: false };
  }
  next.addedAt = session.lines[idx]!.addedAt;
  session.lines[idx] = next;
  session.updatedAt = now;
  return { session, line: next, updated: true };
}

export function removeLine(
  session: StocktakeSession,
  id: string,
  input: { now?: () => string } = {},
): { session: StocktakeSession; line: StocktakeLine } {
  const idx = session.lines.findIndex((line) => line.lineId === id || String(line.productId) === id);
  if (idx === -1) throw new ValidationError(`Stocktake line not found: ${id}`);
  const [removed] = session.lines.splice(idx, 1);
  session.updatedAt = input.now?.() ?? new Date().toISOString();
  return { session, line: removed! };
}

export interface SummarizeOptions {
  /** WMS credential state, so the summary can say whether `submit` will work. */
  wmsStatus?: CredentialStatus;
  /** Fingerprint of the credentials in force now, to detect a mid-count swap. */
  wmsFingerprint?: string;
}

/**
 * Describe whether this session can reach Retail Express, and why not if it
 * can't. Surfaced on every `review` so the limitation is visible during the
 * count rather than at submit time.
 */
function submitAvailability(
  session: StocktakeSession,
  wmsStatus: CredentialStatus | undefined,
  currentFingerprint: string | undefined,
): Record<string, unknown> {
  if (sessionMode(session) === "local") {
    return {
      available: false,
      reason: "local_session",
      hint: "Local sessions never submit. Use `rex stocktake export` for manual entry, or configure WMS and begin a new session.",
    };
  }
  // No credential state supplied: say so rather than claiming a submit will
  // work. Claiming `available: true` unchecked is the one wrong answer here.
  if (!wmsStatus) {
    return {
      available: false,
      reason: "not_checked",
      hint: "Run `rex stocktake review` or `rex doctor` for the current credential state.",
    };
  }
  if (!wmsStatus.configured) {
    return {
      available: false,
      reason: "wms_not_configured",
      missing: wmsStatus.missing,
      source: wmsStatus.source,
      remedy: wmsStatus.remedy,
    };
  }
  if (session.userId === undefined) {
    return {
      available: false,
      reason: "missing_user_id",
      hint: "Begin a new session with `--user-id <id>` or configure `stocktake_user_id`.",
    };
  }
  // Credentials rotated mid-count: submit would refuse, so the summary must not
  // promise otherwise.
  if (currentFingerprint !== undefined && session.wmsFingerprint !== currentFingerprint) {
    return {
      available: false,
      reason: "wms_credentials_changed",
      hint: "Run `rex stocktake abort` and start a new stocktake with the current WMS credentials.",
    };
  }
  return { available: true };
}

export function summarizeSession(
  session: StocktakeSession,
  options: SummarizeOptions = {},
): Record<string, unknown> {
  const nonZero = session.lines.filter((line) => line.variance !== 0);
  return {
    id: session.id,
    profile: session.profile,
    mode: sessionMode(session),
    submit: submitAvailability(session, options.wmsStatus, options.wmsFingerprint),
    outletId: session.outletId,
    outletName: session.outletName,
    userId: session.userId,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    totalLines: session.lines.length,
    submitLines: nonZero.length,
    zeroVarianceLines: session.lines.length - nonZero.length,
    positiveVariance: nonZero.filter((line) => line.variance > 0).reduce((sum, line) => sum + line.variance, 0),
    negativeVariance: nonZero.filter((line) => line.variance < 0).reduce((sum, line) => sum + line.variance, 0),
    lines: session.lines,
  };
}

/**
 * The counted-vs-system worksheet a human types into the Retail Express UI when
 * WMS submission isn't available. Only non-zero variances need action, so they
 * are listed separately from the lines that already agree.
 */
export function buildWorksheet(session: StocktakeSession): Record<string, unknown> {
  const adjust = session.lines.filter((line) => line.variance !== 0);
  const matched = session.lines.filter((line) => line.variance === 0);
  return {
    sessionId: session.id,
    outletId: session.outletId,
    outletName: session.outletName,
    countedAt: session.updatedAt,
    adjustments: adjust.map((line) => ({
      productId: line.productId,
      description: line.description,
      sku: line.sku,
      systemStock: line.currentStock,
      countedStock: line.counted,
      variance: line.variance,
    })),
    alreadyMatching: matched.map((line) => ({
      productId: line.productId,
      description: line.description,
      stock: line.currentStock,
    })),
    totals: {
      counted: session.lines.length,
      needingAdjustment: adjust.length,
      alreadyMatching: matched.length,
    },
  };
}

export async function resolveOutlet(client: RexClient, value: string): Promise<OutletRef> {
  if (/^\d+$/.test(value)) return getOutletById(client, value);
  const pageSize = 250;
  let page = 1;
  let fetched = 0;
  const outlets: Array<{ id?: number; name?: string }> = [];

  for (;;) {
    const res = await listResource<Record<string, unknown>>(client, "outlets", { page, pageSize });
    outlets.push(
      ...res.nodes.map((outlet) => ({
        id: numberField(outlet, ["id", "outlet_id", "WHID", "whid"]),
        name: nameField(outlet),
      })),
    );
    fetched += res.nodes.length;
    if (res.nodes.length === 0 || fetched >= res.pageInfo.total) break;
    page += 1;
  }

  const needle = value.trim().toLowerCase();
  const exactMatches = outlets.filter(
    (outlet) => outlet.id !== undefined && outlet.name?.toLowerCase() === needle,
  );
  const matches =
    exactMatches.length > 0
      ? exactMatches
      : outlets.filter((outlet) => outlet.id !== undefined && outlet.name?.toLowerCase().includes(needle));
  if (matches.length === 1) return { id: matches[0]!.id!, name: matches[0]!.name };
  if (matches.length > 1) {
    throw new ValidationError(`Outlet "${value}" is ambiguous.`, {
      details: { matches: matches.map((m) => ({ id: m.id, name: m.name })) },
    });
  }
  throw new ValidationError(`Outlet not found: ${value}`);
}

async function getOutletById(client: RexClient, value: string): Promise<OutletRef> {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new ValidationError("Outlet id must be a positive integer.");
  }
  try {
    const outlet = await getResource<Record<string, unknown>>(client, "outlets", id);
    return { id, name: nameField(outlet) };
  } catch (err) {
    if (err instanceof NotFoundError) throw new ValidationError(`Outlet not found: ${value}`, { cause: err });
    throw err;
  }
}

export async function resolveProduct(client: RexClient, query: string): Promise<ResolvedProduct> {
  const isNumericQuery = /^\d+$/.test(query);
  const res = await listAllProductSearchResults(client, query);

  if (isNumericQuery) {
    const scanMatches = exactScanMatches(res, query);
    if (scanMatches.length === 1) return normalizeProduct(scanMatches[0]!);
    if (scanMatches.length > 1) throw ambiguousProduct(query, scanMatches);

    try {
      return normalizeProduct(await getProduct(client, query));
    } catch (err) {
      if (!(err instanceof NotFoundError)) throw err;
      // Fall through to the search result. A numeric scan can also be a partial name/model.
    }
  }

  const exactMatches = exactProductMatches(res, query);
  if (exactMatches.length === 1) return normalizeProduct(exactMatches[0]!);
  if (exactMatches.length > 1) throw ambiguousProduct(query, exactMatches);
  if (res.nodes.length === 1) return normalizeProduct(res.nodes[0]!);
  if (res.nodes.length > 1) throw ambiguousProduct(query, res.nodes);
  throw new ValidationError(`Product not found: ${query}`);
}

async function listAllProductSearchResults(client: RexClient, query: string): Promise<ListEnvelope<Product>> {
  const pageSize = 250;
  let page = 1;
  let fetched = 0;
  let total = 0;
  const nodes: Product[] = [];

  for (;;) {
    const res = await listProducts(client, { page, pageSize, query: { search: query } });
    nodes.push(...res.nodes);
    fetched += res.nodes.length;
    total = res.pageInfo.total;
    if (res.nodes.length === 0 || fetched >= total) break;
    page += 1;
  }

  return { nodes, pageInfo: { page: 1, pageSize, total } };
}

export async function fetchOutletInventory(
  client: RexClient,
  productId: number,
  outletId: number,
): Promise<InventorySnapshot> {
  const pageSize = 250;
  let page = 1;
  let fetched = 0;

  for (;;) {
    const res = await listResource<Record<string, unknown>>(client, "inventory", {
      page,
      pageSize,
      query: { product_id: productId },
    });
    const row = res.nodes.find((item) => inventoryOutletId(item) === outletId);
    if (row) {
      const currentStock = numberField(row, ["stock_on_hand", "stockOnHand", "StockOnHand", "qty_on_hand", "QtyOnHand"]);
      if (currentStock === undefined) {
        throw new ValidationError(`Inventory row for product ${productId} did not include stock on hand.`, {
          details: { row },
        });
      }
      return { outletId, currentStock, raw: row };
    }

    fetched += res.nodes.length;
    if (res.nodes.length === 0 || fetched >= res.pageInfo.total) break;
    page += 1;
  }

  throw new ValidationError(`No inventory row found for product ${productId} at outlet ${outletId}.`);
}

export function parseCountArgs(args: string[]): { query: string; counted: number } {
  if (args.length < 2) throw new ValidationError("Usage: rex stocktake count <product words...> <count>");
  const countText = args[args.length - 1]!;
  const counted = Number.parseInt(countText, 10);
  if (!Number.isInteger(counted) || counted < 0 || String(counted) !== countText.trim()) {
    throw new ValidationError("Stocktake count must be a non-negative integer.");
  }
  const query = args.slice(0, -1).join(" ").trim();
  if (!query) throw new ValidationError("Provide a product id, barcode, SKU, or product name.");
  return { query, counted };
}

function exactProductMatches(res: ListEnvelope<Product>, query: string): Product[] {
  const needle = query.trim().toLowerCase();
  return res.nodes.filter((product) =>
    [product.id, ...SCAN_FIELDS.map((field) => product[field])]
      .filter((v) => v !== undefined && v !== null)
      .some((v) => String(v).toLowerCase() === needle),
  );
}

function exactScanMatches(res: ListEnvelope<Product>, query: string): Product[] {
  const needle = query.trim().toLowerCase();
  return res.nodes.filter((product) =>
    SCAN_FIELDS.map((field) => product[field])
      .filter((v) => v !== undefined && v !== null)
      .some((v) => String(v).toLowerCase() === needle),
  );
}

function ambiguousProduct(query: string, matches: Product[]): ValidationError {
  return new ValidationError(`Product "${query}" is ambiguous.`, {
    details: { matches: matches.slice(0, 10).map(productSummary) },
  });
}

function normalizeProduct(product: Product): ResolvedProduct {
  const id = numberField(product, ["id", "product_id", "ProductId", "Product_ID"]);
  if (id === undefined) throw new ValidationError("Resolved product did not include an id.", { details: { product } });
  return {
    id,
    description:
      stringField(product, ["short_description", "description", "name", "ShortDescription", "Description"]) ?? `Product ${id}`,
    sku: stringField(product, ["sku", "SKU", "supplier_sku", "SupplierSKU"]),
    raw: product,
  };
}

function productSummary(product: Product): Record<string, unknown> {
  const normalized = normalizeProduct(product);
  return { id: normalized.id, description: normalized.description, sku: normalized.sku };
}

function nameField(obj: Record<string, unknown>): string | undefined {
  return stringField(obj, ["name", "outlet_name", "warehouse_name", "WarehouseName", "description"]);
}

function inventoryOutletId(obj: Record<string, unknown>): number | undefined {
  return numberField(obj, ["outlet_id", "outletId", "warehouse_id", "warehouseId", "WHID", "whid"]);
}

function stringField(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
}

function numberField(obj: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && /^-?\d+$/.test(value.trim())) return Number.parseInt(value, 10);
  }
  return undefined;
}
