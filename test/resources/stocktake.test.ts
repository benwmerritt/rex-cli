import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { AuthProvider } from "../../src/core/auth";
import { RexClient } from "../../src/core/client";
import { resolveProfile } from "../../src/core/config";
import { ValidationError } from "../../src/core/errors";
import type { Transport } from "../../src/core/transport";
import {
  createSession,
  fetchOutletInventory,
  loadSession,
  maybeLoadSession,
  parseCountArgs,
  removeLine,
  resolveOutlet,
  resolveProduct,
  sessionPath,
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

const auth: AuthProvider = { ensureToken: async () => "T", invalidate: () => {} };

let stateHome: string;
let previousStateHome: string | undefined;

beforeEach(() => {
  previousStateHome = process.env.XDG_STATE_HOME;
  stateHome = mkdtempSync(join(tmpdir(), "rex-stocktake-resource-"));
  process.env.XDG_STATE_HOME = stateHome;
});

afterEach(() => {
  if (previousStateHome === undefined) delete process.env.XDG_STATE_HOME;
  else process.env.XDG_STATE_HOME = previousStateHome;
  rmSync(stateHome, { recursive: true, force: true });
});

function listResponse(data: unknown[], page: number, total: number, pageSize: number): Record<string, unknown> {
  return {
    data,
    page_number: page,
    page_size: pageSize,
    total_records: total,
  };
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
}

function makeClient(handler: (method: string, url: string) => unknown | Response) {
  const calls: Array<{ method: string; url: string }> = [];
  const transport: Transport = async (url, init) => {
    const method = init.method ?? "GET";
    calls.push({ method, url });
    const result = handler(method, url);
    return result instanceof Response ? result : json(result);
  };
  const client = new RexClient({
    baseUrl: "https://x",
    version: "v2.1",
    apiKey: "K",
    auth,
    transport,
    sleep: async () => {},
  });
  return { client, calls };
}

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

  it("removes a line with an injectable timestamp and returns the mutated session", () => {
    const session = createSession({
      profile: "test",
      outlet: { id: 3 },
      userId: 4,
      now: () => "2026-06-18T00:00:00.000Z",
    });
    upsertLine(session, {
      query: "weber q",
      product,
      counted: 6,
      currentStock: 8,
      now: () => "2026-06-18T00:01:00.000Z",
    });

    const result = removeLine(session, "124001", { now: () => "2026-06-18T00:02:00.000Z" });

    expect(result.session).toBe(session);
    expect(result.line).toMatchObject({ productId: 124001, counted: 6, currentStock: 8, variance: -2 });
    expect(session.updatedAt).toBe("2026-06-18T00:02:00.000Z");
    expect(session.lines).toHaveLength(0);
  });

  it("maybeLoadSession returns undefined for a corrupted session file", () => {
    const path = sessionPath("test");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "{not json");

    expect(maybeLoadSession("test")).toBeUndefined();
  });

  it("loadSession reports a corrupted session file with recovery guidance", () => {
    const path = sessionPath("test");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "{not json");

    try {
      loadSession("test");
      throw new Error("Expected loadSession to throw.");
    } catch (err) {
      if (!(err instanceof ValidationError)) throw err;
      expect(err.message).toBe("Stocktake session file is corrupted.");
      expect(err.details).toEqual({
        path,
        hint: "Run `rex stocktake abort` to clear it, then start over.",
      });
      expect(err.cause).toBeInstanceOf(SyntaxError);
    }
  });

  it("isolates API-key-only stocktake sessions by derived profile name", () => {
    const firstTenant = resolveProfile({ env: { REX_API_KEY: "TENANT_A_KEY" } });
    const secondTenant = resolveProfile({ env: { REX_API_KEY: "TENANT_B_KEY" } });

    expect(firstTenant.name).toMatch(/^env-[a-f0-9]{12}$/);
    expect(firstTenant.name).not.toContain("TENANT_A_KEY");
    expect(secondTenant.name).toMatch(/^env-[a-f0-9]{12}$/);
    expect(secondTenant.name).not.toContain("TENANT_B_KEY");
    expect(firstTenant.name).not.toBe(secondTenant.name);
    expect(sessionPath(firstTenant.name)).not.toBe(sessionPath(secondTenant.name));
  });

  it("isolates explicit env-profile stocktake sessions by API key", () => {
    const firstTenant = resolveProfile({ env: { REX_API_KEY: "TENANT_A_KEY", REX_PROFILE: "tenant" } });
    const secondTenant = resolveProfile({ env: { REX_API_KEY: "TENANT_B_KEY", REX_PROFILE: "tenant" } });

    expect(firstTenant.name).toMatch(/^tenant-env-[a-f0-9]{12}$/);
    expect(secondTenant.name).toMatch(/^tenant-env-[a-f0-9]{12}$/);
    expect(firstTenant.name).not.toBe(secondTenant.name);
    expect(sessionPath(firstTenant.name)).not.toBe(sessionPath(secondTenant.name));
  });

  it("resolveOutlet searches later outlet pages", async () => {
    const firstPage = Array.from({ length: 250 }, (_, i) => ({
      id: 1000 + i,
      name: `Outlet ${i}`,
    }));
    const { client, calls } = makeClient((_method, url) => {
      const params = new URL(url).searchParams;
      expect(params.get("page_size")).toBe("250");
      if (params.get("page_number") === "1") return listResponse(firstPage, 1, 251, 250);
      return listResponse([{ id: 3, name: "Mile End" }], 2, 251, 250);
    });

    const result = await resolveOutlet(client, "Mile End");

    expect(result).toEqual({ id: 3, name: "Mile End" });
    expect(calls.map((call) => new URL(call.url).searchParams.get("page_number"))).toEqual(["1", "2"]);
  });

  it("resolveOutlet prefers exact outlet names before substring matches", async () => {
    const { client } = makeClient(() =>
      listResponse(
        [
          { id: 4, name: "Mile End South" },
          { id: 3, name: "Mile End" },
        ],
        1,
        2,
        250,
      ),
    );

    await expect(resolveOutlet(client, "Mile End")).resolves.toEqual({ id: 3, name: "Mile End" });
  });

  it("resolveOutlet validates numeric outlet ids and returns the outlet name", async () => {
    const { client, calls } = makeClient((_method, url) => {
      if (url.endsWith("/outlets/3")) return { id: 3, name: "Mile End" };
      throw new Error(`unexpected URL: ${url}`);
    });

    await expect(resolveOutlet(client, "3")).resolves.toEqual({ id: 3, name: "Mile End" });
    expect(calls.map((call) => new URL(call.url).pathname)).toEqual(["/v2.1/outlets/3"]);
  });

  it("resolveOutlet rejects numeric outlet ids that do not exist", async () => {
    const { client } = makeClient((_method, url) => {
      if (url.endsWith("/outlets/999")) return new Response("{}", { status: 404 });
      throw new Error(`unexpected URL: ${url}`);
    });

    await expect(resolveOutlet(client, "999")).rejects.toThrow("Outlet not found: 999");
  });

  it("fetchOutletInventory searches later inventory pages for the outlet row", async () => {
    const firstPage = Array.from({ length: 250 }, (_, i) => ({
      product_id: 124001,
      outlet_id: 1000 + i,
      stock_on_hand: 0,
    }));
    const { client, calls } = makeClient((_method, url) => {
      const params = new URL(url).searchParams;
      expect(params.get("product_id")).toBe("124001");
      if (params.get("page_number") === "1") return listResponse(firstPage, 1, 251, 250);
      return listResponse([{ product_id: 124001, outlet_id: 3, stock_on_hand: "8" }], 2, 251, 250);
    });

    const result = await fetchOutletInventory(client, 124001, 3);

    expect(result).toMatchObject({ outletId: 3, currentStock: 8 });
    expect(calls.map((call) => new URL(call.url).searchParams.get("page_number"))).toEqual(["1", "2"]);
  });

  it("fetchOutletInventory does not use available stock as stock on hand", async () => {
    const { client } = makeClient(() =>
      listResponse([{ product_id: 124001, outlet_id: 3, available: 6 }], 1, 1, 250),
    );

    await expect(fetchOutletInventory(client, 124001, 3)).rejects.toThrow(
      "Inventory row for product 124001 did not include stock on hand.",
    );
  });

  it("resolveProduct prefers exact numeric barcode and SKU matches before product-id lookup", async () => {
    const { client, calls } = makeClient((_method, url) => {
      if (url.includes("/products?")) {
        const params = new URL(url).searchParams;
        expect(params.get("page_size")).toBe("250");
        return listResponse([{ id: 999, barcode: "124001", short_description: "Scanned Product" }], 1, 1, 250);
      }
      throw new Error(`unexpected product-id lookup: ${url}`);
    });

    const result = await resolveProduct(client, "124001");

    expect(result).toMatchObject({ id: 999, description: "Scanned Product" });
    expect(calls).toHaveLength(1);
    expect(new URL(calls[0]!.url).searchParams.get("search")).toBe("124001");
  });

  it("resolveProduct matches numeric manufacturer SKU before product-id lookup", async () => {
    const { client, calls } = makeClient((_method, url) => {
      if (url.includes("/products?")) {
        const params = new URL(url).searchParams;
        expect(params.get("page_size")).toBe("250");
        return listResponse(
          [{ id: 998, manufacturer_sku: "124001", short_description: "Manufacturer SKU Product" }],
          1,
          1,
          250,
        );
      }
      throw new Error(`unexpected product-id lookup: ${url}`);
    });

    const result = await resolveProduct(client, "124001");

    expect(result).toMatchObject({ id: 998, description: "Manufacturer SKU Product" });
    expect(calls).toHaveLength(1);
  });

  it("resolveProduct prefers exact numeric scan matches on later pages before product-id lookup", async () => {
    const firstPage = Array.from({ length: 250 }, (_, i) => ({
      id: 2000 + i,
      barcode: `OTHER-${i}`,
      short_description: `Other Product ${i}`,
    }));
    const { client, calls } = makeClient((_method, url) => {
      if (url.includes("/products?")) {
        const params = new URL(url).searchParams;
        expect(params.get("page_size")).toBe("250");
        if (params.get("page_number") === "1") return listResponse(firstPage, 1, 251, 250);
        return listResponse([{ id: 999, barcode: "124001", short_description: "Scanned Product" }], 2, 251, 250);
      }
      throw new Error(`unexpected product-id lookup: ${url}`);
    });

    const result = await resolveProduct(client, "124001");

    expect(result).toMatchObject({ id: 999, description: "Scanned Product" });
    expect(calls.map((call) => new URL(call.url).searchParams.get("page_number"))).toEqual(["1", "2"]);
  });

  it("resolveProduct falls back to product-id lookup when a numeric scan has no exact barcode or SKU match", async () => {
    const { client, calls } = makeClient((_method, url) => {
      if (url.includes("/products?")) {
        const params = new URL(url).searchParams;
        expect(params.get("page_size")).toBe("250");
        return listResponse([{ id: 999, barcode: "OTHER", short_description: "Other Product" }], 1, 1, 250);
      }
      if (url.endsWith("/products/124001")) {
        return { id: 124001, short_description: "Product Id Match", sku: "WQ2200" };
      }
      throw new Error(`unexpected URL: ${url}`);
    });

    const result = await resolveProduct(client, "124001");

    expect(result).toMatchObject({ id: 124001, description: "Product Id Match", sku: "WQ2200" });
    expect(calls.map((call) => new URL(call.url).pathname)).toEqual(["/v2.1/products", "/v2.1/products/124001"]);
  });

  it("resolveProduct falls back to product-id lookup after exhaustive numeric scan search", async () => {
    const products = Array.from({ length: 250 }, (_, i) => ({
      id: 2000 + i,
      barcode: `OTHER-${i}`,
      short_description: `Other Product ${i}`,
    }));
    const { client, calls } = makeClient((_method, url) => {
      if (url.includes("/products?")) {
        const params = new URL(url).searchParams;
        if (params.get("page_number") === "1") return listResponse(products, 1, 251, 250);
        return listResponse([{ id: 3000, barcode: "OTHER-LAST", short_description: "Other Last Product" }], 2, 251, 250);
      }
      if (url.endsWith("/products/124001")) {
        return { id: 124001, short_description: "Product Id Match", sku: "WQ2200" };
      }
      throw new Error(`unexpected URL: ${url}`);
    });

    const result = await resolveProduct(client, "124001");

    expect(result).toMatchObject({ id: 124001, description: "Product Id Match", sku: "WQ2200" });
    expect(calls.map((call) => new URL(call.url).pathname)).toEqual([
      "/v2.1/products",
      "/v2.1/products",
      "/v2.1/products/124001",
    ]);
  });

  it("resolveProduct reports ambiguous exact numeric scan matches", async () => {
    const { client } = makeClient((_method, url) => {
      if (url.includes("/products?")) {
        const params = new URL(url).searchParams;
        expect(params.get("page_size")).toBe("250");
        return listResponse(
          [
            { id: 1, barcode: "123456", short_description: "Barcode Match" },
            { id: 2, sku: "123456", short_description: "SKU Match" },
          ],
          1,
          2,
          250,
        );
      }
      throw new Error(`unexpected product-id lookup: ${url}`);
    });

    await expect(resolveProduct(client, "123456")).rejects.toThrow('Product "123456" is ambiguous.');
  });

  it("resolveProduct finds exact non-numeric SKU matches on later pages", async () => {
    const firstPage = Array.from({ length: 250 }, (_, i) => ({
      id: 2000 + i,
      sku: `OTHER-${i}`,
      short_description: `Other Product ${i}`,
    }));
    const { client, calls } = makeClient((_method, url) => {
      if (url.includes("/products?")) {
        const params = new URL(url).searchParams;
        expect(params.get("page_size")).toBe("250");
        if (params.get("page_number") === "1") return listResponse(firstPage, 1, 251, 250);
        return listResponse([{ id: 999, sku: "WQ2200", short_description: "Weber Q 2200" }], 2, 251, 250);
      }
      throw new Error(`unexpected URL: ${url}`);
    });

    const result = await resolveProduct(client, "WQ2200");

    expect(result).toMatchObject({ id: 999, description: "Weber Q 2200", sku: "WQ2200" });
    expect(calls.map((call) => new URL(call.url).searchParams.get("page_number"))).toEqual(["1", "2"]);
  });

  it("resolveProduct reports ambiguous non-numeric exact matches across pages", async () => {
    const firstPage = [
      { id: 998, sku: "WQ2200", short_description: "Weber Q 2200 First" },
      ...Array.from({ length: 249 }, (_, i) => ({
        id: 2000 + i,
        sku: `OTHER-${i}`,
        short_description: `Other Product ${i}`,
      })),
    ];
    const { client, calls } = makeClient((_method, url) => {
      if (url.includes("/products?")) {
        const params = new URL(url).searchParams;
        expect(params.get("page_size")).toBe("250");
        if (params.get("page_number") === "1") return listResponse(firstPage, 1, 251, 250);
        return listResponse([{ id: 999, sku: "WQ2200", short_description: "Weber Q 2200 Second" }], 2, 251, 250);
      }
      throw new Error(`unexpected URL: ${url}`);
    });

    await expect(resolveProduct(client, "WQ2200")).rejects.toThrow('Product "WQ2200" is ambiguous.');
    expect(calls.map((call) => new URL(call.url).searchParams.get("page_number"))).toEqual(["1", "2"]);
  });
});
