import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildProgram } from "../src/cli/program";
import type { AuthProvider } from "../src/core/auth";
import { RexClient } from "../src/core/client";
import { resolveProfile } from "../src/core/config";
import { Output } from "../src/core/output";
import { openSalesDb, salesDbFile, setMeta } from "../src/core/salesdb";
import type { Transport } from "../src/core/transport";
import { capture } from "./helpers/capture";

const auth: AuthProvider = { ensureToken: async () => "T", invalidate: () => {} };
const ENV = { REX_API_KEY: "K" };

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

async function runCli(argv: string[], handler: (method: string, url: string) => unknown) {
  const out = capture();
  const err = capture();
  const program = buildProgram({
    env: ENV,
    clientFactory: () => fakeClient(handler),
    output: new Output({ mode: "json" }, out.writer, err.writer),
  });
  // exitOverride must reach the subcommands (created before this call) or a
  // commander-level error there calls process.exit and kills the test runner.
  const overrideExits = (cmd: typeof program): void => {
    cmd.exitOverride();
    cmd.commands.forEach(overrideExits);
  };
  overrideExits(program);
  program.configureOutput({ writeErr: (str) => err.writer.write(str) });
  await program.parseAsync(["node", "rex", ...argv]);
  return { out: out.text(), err: err.text() };
}

// Two fake order pages (server page_size 2, total 3): Jane sells twice at
// Mile End in Aug/Sep 2025 (FY2026), Bob once. Item on order 1 is qty 2.
function order(id: number, createdOn: string, sp: { id: number; name: string }, total: number) {
  const [first, surname] = sp.name.split(" ");
  return {
    id,
    created_on: createdOn,
    modified_on: createdOn,
    order_status: { id: 12, status: "Processed" },
    sales_person: { id: sp.id, first_name: first, surname },
    outlet: { id: 2, name: "Mile End" },
    order_total: total,
    freight_total: 0,
    customer: { id: 100001 },
    order_items: [
      {
        id: id * 10,
        order_item_type: "Sale",
        product: { id: 100, short_description: "Widget", product_type: { id: 1, name: "Mug" } },
        quantity_ordered: 2,
        sell_price: total / 2,
        order_item_total: total,
        order_item_discount_total: 0,
        tax_rate: 0.1,
        cogs_ex: 10,
      },
    ],
  };
}

const JANE = { id: 1, name: "Jane Doe" };
const BOB = { id: 2, name: "Bob Smith" };
const PAGES: Record<string, unknown[]> = {
  "1": [order(1, "2025-08-15T10:00:00+09:30", JANE, 110), order(2, "2025-09-02T12:00:00+09:30", JANE, 50)],
  "2": [order(3, "2025-09-10T09:00:00+09:30", BOB, 40)],
};

let lastOrdersUrl = "";
function ordersHandler(method: string, url: string): unknown {
  if (method !== "GET" || !url.includes("/orders")) throw new Error(`unexpected ${method} ${url}`);
  lastOrdersUrl = url;
  const page = new URL(url).searchParams.get("page_number") ?? "1";
  return { data: PAGES[page] ?? [], page_number: Number(page), page_size: 2, total_records: 3 };
}

describe("rex sales (golden)", () => {
  const prevStateHome = process.env.XDG_STATE_HOME;
  const prevExit = process.exitCode;
  let tmp: string | undefined;

  function freshStateDir(): void {
    tmp = mkdtempSync(join(tmpdir(), "rex-sales-"));
    process.env.XDG_STATE_HOME = tmp;
  }

  afterEach(() => {
    if (prevStateHome === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = prevStateHome;
    if (tmp) rmSync(tmp, { recursive: true, force: true });
    tmp = undefined;
    process.exitCode = prevExit;
  });

  it("sync pages orders into the cache, then report --by salesperson is offline", async () => {
    freshStateDir();

    const sync = await runCli(["sales", "sync"], ordersHandler);
    const syncResult = JSON.parse(sync.out);
    expect(syncResult).toMatchObject({
      fullSync: true,
      ordersSynced: 3,
      pages: 2,
      statuses: { Processed: 3 },
      negativeTotals: 0,
    });
    expect(syncResult.watermark).toBe("2025-09-10T09:00:00+09:30");

    // Report must not touch the network.
    const report = await runCli(["sales", "report", "--fy", "2026", "--by", "salesperson"], () => {
      throw new Error("report must not call the API");
    });
    const envelope = JSON.parse(report.out);
    expect(envelope.period.label).toBe("FY2026");
    expect(envelope.by).toEqual(["salesperson"]);
    expect(envelope.sort).toBe("revenue");
    expect(typeof envelope.synced_at).toBe("string");
    expect(envelope.stale_hours).toBeLessThanOrEqual(0.1);
    expect(envelope.rows).toHaveLength(2);
    expect(envelope.rows[0]).toMatchObject({
      salesperson_id: 1,
      salesperson_name: "Jane Doe",
      revenue: 160,
      orders: 2,
      units: 4,
    });
    expect(envelope.rows[1]).toMatchObject({ salesperson_name: "Bob Smith", revenue: 40 });
  });

  it("report without a cache tells the user to sync (exit 6)", async () => {
    freshStateDir();
    const { out, err } = await runCli(["sales", "report", "--fy", "2026"], () => {
      throw new Error("no API calls expected");
    });
    expect(out).toBe("");
    expect(JSON.parse(err).error).toMatchObject({
      code: "validation",
      message: "No sales cache for this profile. Run `rex sales sync` first.",
    });
    expect(process.exitCode).toBe(6);
  });

  it("report --max-stale exits 9 when the cache is too old", async () => {
    freshStateDir();
    await runCli(["sales", "sync"], ordersHandler);

    // Backdate the sync stamp 48h, then demand freshness within 24h.
    const profile = resolveProfile({ env: ENV }).name;
    const db = openSalesDb(salesDbFile(profile));
    setMeta(db, "last_synced_at", new Date(Date.now() - 48 * 3_600_000).toISOString());
    db.close();

    const { out, err } = await runCli(
      ["sales", "report", "--fy", "2026", "--by", "salesperson", "--max-stale", "24"],
      () => {
        throw new Error("no API calls expected");
      },
    );
    expect(out).toBe("");
    expect(JSON.parse(err).error.code).toBe("stale_cache");
    expect(process.exitCode).toBe(9);
  });

  it("report refuses a cache whose first sync never completed (exit 9)", async () => {
    freshStateDir();
    await runCli(["sales", "sync"], ordersHandler);

    // Simulate a first sync that died mid-stream: resume cursor present, no
    // completion stamp. The partial cache must be refused, not under-reported.
    const profile = resolveProfile({ env: ENV }).name;
    const db = openSalesDb(salesDbFile(profile));
    db.query("DELETE FROM meta WHERE key = 'last_synced_at'").run();
    setMeta(db, "full_sync_page", "2");
    db.close();

    const { out, err } = await runCli(["sales", "report", "--fy", "2026"], () => {
      throw new Error("no API calls expected");
    });
    expect(out).toBe("");
    expect(JSON.parse(err).error.code).toBe("stale_cache");
    expect(process.exitCode).toBe(9);
  });

  it("--max-stale compares the exact age, not the 0.1h-rounded display value", async () => {
    freshStateDir();
    await runCli(["sales", "sync"], ordersHandler);

    // 24h02m old: displays as 24.0h but must still trip --max-stale 24.
    const profile = resolveProfile({ env: ENV }).name;
    const db = openSalesDb(salesDbFile(profile));
    setMeta(db, "last_synced_at", new Date(Date.now() - (24 * 60 + 2) * 60_000).toISOString());
    db.close();

    const { err } = await runCli(
      ["sales", "report", "--fy", "2026", "--max-stale", "24"],
      () => {
        throw new Error("no API calls expected");
      },
    );
    expect(JSON.parse(err).error.code).toBe("stale_cache");
    expect(process.exitCode).toBe(9);
  });

  it("full-sync resume past the final page still lands the watermark", async () => {
    freshStateDir();
    await runCli(["sales", "sync"], ordersHandler);

    // Simulate a crash after the final page committed but before the meta
    // writes: cursor at the last page, no watermark, no completion stamp.
    const profile = resolveProfile({ env: ENV }).name;
    const db = openSalesDb(salesDbFile(profile));
    db.query("DELETE FROM meta WHERE key IN ('watermark', 'last_synced_at')").run();
    setMeta(db, "full_sync_page", "2");
    db.close();

    const resumed = JSON.parse((await runCli(["sales", "sync"], ordersHandler)).out);
    expect(resumed).toMatchObject({ fullSync: true, ordersSynced: 0, resumedFromPage: 3 });
    // Watermark recovered from the already-committed rows, not this run's (empty) pages.
    expect(resumed.watermark).toBe("2025-09-10T09:00:00+09:30");

    // Next run must be incremental, not another ~full re-stream, and must ask
    // the API for the watermark minus the 24h overlap — not just claim it did.
    const next = JSON.parse((await runCli(["sales", "sync"], ordersHandler)).out);
    expect(next.fullSync).toBe(false);
    expect(new URL(lastOrdersUrl).searchParams.get("modified_since")).toBe(
      new Date(Date.parse("2025-09-10T09:00:00+09:30") - 24 * 3_600_000).toISOString(),
    );
  });

  it("rejects non-integer --fy with a clean usage error (exit 2)", async () => {
    freshStateDir();
    for (const bad of ["abc", "2026.5"]) {
      await expect(
        runCli(["sales", "report", "--fy", bad], () => {
          throw new Error("no API calls expected");
        }),
      ).rejects.toMatchObject({ code: "commander.invalidArgument", exitCode: 2 });
    }
  });

  it("rejects negative and blank --max-stale with a usage error (exit 2)", async () => {
    freshStateDir();
    for (const bad of ["-1", " "]) {
      await expect(
        runCli(["sales", "report", "--fy", "2026", "--max-stale", bad], () => {
          throw new Error("no API calls expected");
        }),
      ).rejects.toMatchObject({ code: "commander.invalidArgument", exitCode: 2 });
    }
  });

  it("rejects junk --by dimensions (exit 6)", async () => {
    freshStateDir();
    await runCli(["sales", "sync"], ordersHandler);
    const { err } = await runCli(["sales", "report", "--by", "vibes"], () => {
      throw new Error("no API calls expected");
    });
    expect(JSON.parse(err).error.code).toBe("validation");
    expect(process.exitCode).toBe(6);
  });
});
