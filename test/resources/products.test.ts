import { describe, expect, it } from "bun:test";
import type { AuthProvider } from "../../src/core/auth";
import type { AuditRecord } from "../../src/core/audit";
import { RexClient } from "../../src/core/client";
import { WriteGatedError } from "../../src/core/errors";
import type { Transport } from "../../src/core/transport";
import {
  createProduct,
  disableProduct,
  updateProduct,
  type WriteOptions,
} from "../../src/resources/products";

const auth: AuthProvider = { ensureToken: async () => "T", invalidate: () => {} };

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
}

interface Call {
  method: string;
  url: string;
  body?: unknown;
}

function makeClient(current: Record<string, unknown>) {
  const calls: Call[] = [];
  const transport: Transport = async (url, init) => {
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ method, url, body });
    if (method === "GET") return json(current);
    if (method === "POST") return json({ ...current, id: 999 });
    return json({ ok: true });
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

function opts(over: Partial<WriteOptions> = {}): { o: WriteOptions; audits: AuditRecord[] } {
  const audits: AuditRecord[] = [];
  return {
    audits,
    o: { profile: "p", now: () => "TS", audit: (r) => audits.push(r), ...over },
  };
}

const CURRENT = { id: 1, short_description: "Old", brand: "Acme", web_price_inc: 10 };

describe("updateProduct", () => {
  it("sends only changed fields and records an audit entry", async () => {
    const { client, calls } = makeClient(CURRENT);
    const { o, audits } = opts();
    const res = await updateProduct(client, { id: 1, short_description: "New", brand: "Acme" }, o);

    expect(res).toMatchObject({ id: 1, action: "update", changed: ["short_description"], dryRun: false });
    const put = calls.find((c) => c.method === "PUT")!;
    expect(put.url).toContain("/v2.1/products/1");
    expect(put.body).toEqual({ short_description: "New" });
    expect(audits[0]).toMatchObject({
      action: "update",
      id: 1,
      changed: ["short_description"],
      before: { short_description: "Old" },
      after: { short_description: "New" },
      ts: "TS",
    });
  });

  it("skips a no-op update without writing", async () => {
    const { client, calls } = makeClient(CURRENT);
    const res = await updateProduct(client, { id: 1, brand: "Acme" }, opts().o);
    expect(res.skipped).toBe(true);
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
  });

  it("refuses price writes without allowPrice (apply) and sends nothing", async () => {
    const { client, calls } = makeClient(CURRENT);
    await expect(updateProduct(client, { id: 1, web_price_inc: 12 }, opts().o)).rejects.toBeInstanceOf(
      WriteGatedError,
    );
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
  });

  it("reports (does not throw) gated price fields in dry-run", async () => {
    const { client, calls } = makeClient(CURRENT);
    const res = await updateProduct(client, { id: 1, web_price_inc: 12 }, opts({ dryRun: true }).o);
    expect(res.dryRun).toBe(true);
    expect(res.priceGated).toEqual(["web_price_inc"]);
    expect(res.diff).toEqual({ web_price_inc: 12 });
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
  });

  it("writes price fields when allowPrice is set", async () => {
    const { client, calls } = makeClient(CURRENT);
    const res = await updateProduct(client, { id: 1, web_price_inc: 12 }, opts({ allowPrice: true }).o);
    expect(res.changed).toEqual(["web_price_inc"]);
    expect(calls.find((c) => c.method === "PUT")!.body).toEqual({ web_price_inc: 12 });
  });
});

describe("createProduct", () => {
  it("POSTs the body and returns the new id", async () => {
    const { client, calls } = makeClient(CURRENT);
    const res = await createProduct(client, { short_description: "X" }, opts().o);
    expect(res).toMatchObject({ action: "create", id: 999, dryRun: false });
    expect(calls.find((c) => c.method === "POST")!.body).toEqual({ short_description: "X" });
  });

  it("gates price fields on create", async () => {
    const { client } = makeClient(CURRENT);
    await expect(createProduct(client, { web_price_inc: 5 }, opts().o)).rejects.toBeInstanceOf(
      WriteGatedError,
    );
  });
});

describe("disableProduct", () => {
  it("DELETEs in apply mode and audits a disable", async () => {
    const { client, calls } = makeClient(CURRENT);
    const { o, audits } = opts();
    const res = await disableProduct(client, "1", o);
    expect(res).toMatchObject({ id: 1, action: "disable", dryRun: false });
    expect(calls.find((c) => c.method === "DELETE")!.url).toContain("/products/1");
    expect(audits[0]!.action).toBe("disable");
  });

  it("sends nothing in dry-run", async () => {
    const { client, calls } = makeClient(CURRENT);
    const res = await disableProduct(client, "1", opts({ dryRun: true }).o);
    expect(res.dryRun).toBe(true);
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
  });
});
