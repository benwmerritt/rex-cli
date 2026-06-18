import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildProgram } from "../../src/cli/program";
import type { AuthProvider } from "../../src/core/auth";
import { RexClient } from "../../src/core/client";
import { Output, type Writer } from "../../src/core/output";
import type { Transport } from "../../src/core/transport";
import type { CreateStocktakeInput, WmsClientLike } from "../../src/core/wms";

const auth: AuthProvider = { ensureToken: async () => "T", invalidate: () => {} };

let stateDir: string;
let previousStateHome: string | undefined;

beforeEach(() => {
  previousStateHome = process.env.XDG_STATE_HOME;
  stateDir = mkdtempSync(join(tmpdir(), "rex-stocktake-"));
  process.env.XDG_STATE_HOME = stateDir;
  process.exitCode = 0;
});

afterEach(() => {
  if (previousStateHome === undefined) delete process.env.XDG_STATE_HOME;
  else process.env.XDG_STATE_HOME = previousStateHome;
  rmSync(stateDir, { recursive: true, force: true });
  process.exitCode = 0;
});

function fakeClient(handler: (method: string, url: string) => unknown) {
  const transport: Transport = async (url, init) =>
    new Response(JSON.stringify(handler(init.method ?? "GET", url)), {
      headers: { "content-type": "application/json" },
    });
  return new RexClient({
    baseUrl: "https://x",
    version: "v2.1",
    apiKey: "K",
    auth,
    transport,
    sleep: async () => {},
  });
}

function capture() {
  const chunks: string[] = [];
  const writer: Writer = { write: (s) => void chunks.push(s) };
  return { writer, text: () => chunks.join("") };
}

async function runCli(
  argv: string[],
  handler: (method: string, url: string) => unknown,
  wms?: WmsClientLike,
) {
  const out = capture();
  const err = capture();
  const program = buildProgram({
    env: { REX_API_KEY: "K", REX_PROFILE: "test", REX_STOCKTAKE_USER_ID: "4" },
    clientFactory: () => fakeClient(handler),
    wmsClientFactory: () =>
      wms ?? {
        createStocktake: async () => ({ ok: true, result: "Success" }),
      },
    output: new Output({ mode: "json" }, out.writer, err.writer),
  });
  program.exitOverride();
  await program.parseAsync(["node", "rex", ...argv]);
  return { out: out.text(), err: err.text() };
}

function retailExpressFixture(method: string, url: string): unknown {
  if (url.includes("/products?")) {
    return { data: [], page_number: 1, page_size: 10, total_records: 0 };
  }
  if (url.includes("/products/124001")) return { id: 124001, short_description: "Weber Q 2200", sku: "WQ2200" };
  if (url.includes("/inventory")) {
    return {
      data: [{ product_id: 124001, outlet_id: 3, stock_on_hand: 8 }],
      page_number: 1,
      page_size: 250,
      total_records: 1,
    };
  }
  throw new Error(`unexpected ${method} ${url}`);
}

describe("rex stocktake", () => {
  it("stages a counted quantity and previews the WMS stocktake variance payload", async () => {
    await runCli(["stocktake", "begin", "--outlet", "3"], retailExpressFixture);
    const counted = await runCli(["stocktake", "count", "124001", "6"], retailExpressFixture);
    expect(JSON.parse(counted.out).line).toMatchObject({
      productId: 124001,
      counted: 6,
      currentStock: 8,
      variance: -2,
    });

    const preview = await runCli(["--dry-run", "stocktake", "submit"], retailExpressFixture);
    expect(JSON.parse(preview.out)).toMatchObject({
      dryRun: true,
      action: "stocktake_submit",
      submitLines: 1,
      payload: { outletId: 3, userId: 4, items: [{ productId: 124001, variance: -2 }] },
    });
  });

  it("submits through the injected WMS client and clears the session", async () => {
    await runCli(["stocktake", "begin", "--outlet", "3"], retailExpressFixture);
    await runCli(["stocktake", "count", "124001", "6"], retailExpressFixture);

    let seen: CreateStocktakeInput | undefined;
    const wms: WmsClientLike = {
      createStocktake: async (input) => {
        seen = input;
        return { ok: true, result: "Success" };
      },
    };
    const submitted = await runCli(["stocktake", "submit"], retailExpressFixture, wms);
    expect(seen).toEqual({ outletId: 3, userId: 4, items: [{ productId: 124001, variance: -2 }] });
    expect(JSON.parse(submitted.out)).toMatchObject({ ok: true, submitted: true, cleared: true });

    const review = await runCli(["stocktake", "review"], retailExpressFixture);
    expect(JSON.parse(review.err).error.code).toBe("validation");
    process.exitCode = 0;
  });

  it("clears the session after WMS success even if audit logging fails", async () => {
    await runCli(["stocktake", "begin", "--outlet", "3"], retailExpressFixture);
    await runCli(["stocktake", "count", "124001", "6"], retailExpressFixture);
    mkdirSync(join(stateDir, "rex", "audit.jsonl"), { recursive: true });

    let submissions = 0;
    const wms: WmsClientLike = {
      createStocktake: async () => {
        submissions += 1;
        return { ok: true, result: "Success" };
      },
    };
    const submitted = await runCli(["stocktake", "submit"], retailExpressFixture, wms);
    expect(submissions).toBe(1);
    expect(submitted.err).toBe("");
    expect(JSON.parse(submitted.out)).toMatchObject({
      ok: true,
      submitted: true,
      cleared: true,
      audit: {
        warning: "Stocktake was submitted and the session was cleared, but audit logging failed.",
      },
    });

    const review = await runCli(["stocktake", "review"], retailExpressFixture);
    expect(JSON.parse(review.err).error.code).toBe("validation");
    process.exitCode = 0;
  });
});
