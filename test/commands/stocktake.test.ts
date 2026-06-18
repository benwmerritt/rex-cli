import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildProgram } from "../../src/cli/program";
import type { AuthProvider } from "../../src/core/auth";
import { RexClient } from "../../src/core/client";
import { saveProfile } from "../../src/core/config";
import { ApiError } from "../../src/core/errors";
import { Output } from "../../src/core/output";
import type { Transport } from "../../src/core/transport";
import type { CreateStocktakeInput, WmsClientLike } from "../../src/core/wms";
import { capture } from "../helpers/capture";

const auth: AuthProvider = { ensureToken: async () => "T", invalidate: () => {} };

let stateDir: string;
let previousStateHome: string | undefined;
let configHome: string;
let previousConfigHome: string | undefined;

beforeEach(() => {
  previousStateHome = process.env.XDG_STATE_HOME;
  previousConfigHome = process.env.XDG_CONFIG_HOME;
  stateDir = mkdtempSync(join(tmpdir(), "rex-stocktake-"));
  configHome = mkdtempSync(join(tmpdir(), "rex-stocktake-config-"));
  process.env.XDG_STATE_HOME = stateDir;
  process.env.XDG_CONFIG_HOME = configHome;
  process.exitCode = 0;
});

afterEach(() => {
  if (previousStateHome === undefined) delete process.env.XDG_STATE_HOME;
  else process.env.XDG_STATE_HOME = previousStateHome;
  if (previousConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = previousConfigHome;
  rmSync(stateDir, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
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

async function runCli(
  argv: string[],
  handler: (method: string, url: string) => unknown,
  wms?: WmsClientLike,
  env: NodeJS.ProcessEnv = { REX_API_KEY: "K", REX_PROFILE: "test", REX_STOCKTAKE_USER_ID: "4" },
) {
  const out = capture();
  const err = capture();
  const program = buildProgram({
    env,
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
  if (url.endsWith("/outlets/3")) return { id: 3, name: "Mile End" };
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

function activeSessionPath(): string {
  const dir = join(stateDir, "rex");
  const sessions = readdirSync(dir).filter((name) => name.startsWith("stocktake.") && name.endsWith(".json"));
  expect(sessions).toHaveLength(1);
  return join(dir, sessions[0]!);
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

  it("uses explicit --user-id without validating an invalid stocktake env fallback", async () => {
    const started = await runCli(
      ["stocktake", "begin", "--outlet", "3", "--user-id", "4"],
      retailExpressFixture,
      undefined,
      { REX_API_KEY: "K", REX_PROFILE: "test", REX_STOCKTAKE_USER_ID: "-1" },
    );

    expect(JSON.parse(started.out)).toMatchObject({ ok: true, session: { outletId: 3, userId: 4 } });
    expect(started.err).toBe("");
  });

  it("does not load a stocktake session from the same config profile after the API key changes", async () => {
    saveProfile({ name: "tenant", apiKey: "K1" });
    const env = { REX_PROFILE: "tenant", REX_STOCKTAKE_USER_ID: "4" };

    await runCli(["stocktake", "begin", "--outlet", "3"], retailExpressFixture, undefined, env);
    saveProfile({ name: "tenant", apiKey: "K2" });

    const wrongTenant = await runCli(["stocktake", "review"], retailExpressFixture, undefined, env);
    expect(wrongTenant.out).toBe("");
    expect(JSON.parse(wrongTenant.err).error).toMatchObject({
      code: "validation",
      message: "No active stocktake session.",
    });

    process.exitCode = 0;
    saveProfile({ name: "tenant", apiKey: "K1" });
    const originalTenant = await runCli(["stocktake", "review"], retailExpressFixture, undefined, env);
    expect(JSON.parse(originalTenant.out)).toMatchObject({ profile: "tenant", outletId: 3, userId: 4 });
  });

  it("does not load an env-mode stocktake session after the API key changes", async () => {
    const firstTenant = { REX_API_KEY: "K1", REX_STOCKTAKE_USER_ID: "4" };
    const secondTenant = { REX_API_KEY: "K2", REX_STOCKTAKE_USER_ID: "4" };

    await runCli(["stocktake", "begin", "--outlet", "3"], retailExpressFixture, undefined, firstTenant);

    const wrongTenant = await runCli(["stocktake", "review"], retailExpressFixture, undefined, secondTenant);
    expect(wrongTenant.out).toBe("");
    expect(JSON.parse(wrongTenant.err).error).toMatchObject({
      code: "validation",
      message: "No active stocktake session.",
    });

    process.exitCode = 0;
    const originalTenant = await runCli(["stocktake", "review"], retailExpressFixture, undefined, firstTenant);
    expect(JSON.parse(originalTenant.out)).toMatchObject({ outletId: 3, userId: 4 });
  });

  it("keeps the session and warns before retry after ambiguous WMS submit failure", async () => {
    await runCli(["stocktake", "begin", "--outlet", "3"], retailExpressFixture);
    await runCli(["stocktake", "count", "124001", "6"], retailExpressFixture);

    const wms: WmsClientLike = {
      createStocktake: async () => {
        throw new ApiError("Retail Express WMS returned HTTP 500.", 500, {
          details: { body: "server unavailable" },
        });
      },
    };

    const submitted = await runCli(["stocktake", "submit"], retailExpressFixture, wms);

    expect(submitted.out).toBe("");
    expect(JSON.parse(submitted.err).error).toMatchObject({
      code: "api",
      message: "Retail Express WMS returned HTTP 500. Local stocktake session was kept, but WMS may have processed the request.",
      details: {
        body: "server unavailable",
        stocktakeSession: {
          preserved: true,
          warning: "WMS may have processed this stocktake before the failure was reported.",
          hint: "Check WMS for an awaiting-authorisation stocktake before retrying to avoid duplicate stocktakes.",
        },
      },
    });

    process.exitCode = 0;
    const review = await runCli(["stocktake", "review"], retailExpressFixture);
    expect(JSON.parse(review.out)).toMatchObject({ totalLines: 1, submitLines: 1 });
  });

  it("warns about duplicate risk after a status-0 WMS timeout", async () => {
    await runCli(["stocktake", "begin", "--outlet", "3"], retailExpressFixture);
    await runCli(["stocktake", "count", "124001", "6"], retailExpressFixture);

    const cause = Object.assign(new Error("connect ETIMEDOUT"), { code: "ETIMEDOUT" });
    const wms: WmsClientLike = {
      createStocktake: async () => {
        throw new ApiError("Retail Express WMS request timed out after 25ms.", 0, { cause });
      },
    };

    const submitted = await runCli(["stocktake", "submit"], retailExpressFixture, wms);

    expect(submitted.out).toBe("");
    const error = JSON.parse(submitted.err).error;
    expect(error).toMatchObject({
      code: "api",
      message: "Retail Express WMS request timed out after 25ms. Local stocktake session was kept, but WMS may have processed the request.",
      details: {
        stocktakeSession: {
          preserved: true,
          warning: "WMS may have processed this stocktake before the failure was reported.",
          hint: "Check WMS for an awaiting-authorisation stocktake before retrying to avoid duplicate stocktakes.",
        },
      },
    });

    process.exitCode = 0;
    const review = await runCli(["stocktake", "review"], retailExpressFixture);
    expect(JSON.parse(review.out)).toMatchObject({ totalLines: 1, submitLines: 1 });
  });

  it("reports invalid stocktake env fallback when begin needs it", async () => {
    const started = await runCli(
      ["stocktake", "begin", "--outlet", "3"],
      retailExpressFixture,
      undefined,
      { REX_API_KEY: "K", REX_PROFILE: "test", REX_STOCKTAKE_USER_ID: "-1" },
    );

    expect(started.out).toBe("");
    expect(JSON.parse(started.err).error).toMatchObject({
      code: "validation",
      message: "REX_STOCKTAKE_USER_ID must be a positive integer.",
    });
  });

  it("clears the session after WMS success even if audit logging fails", async () => {
    await runCli(["stocktake", "begin", "--outlet", "3"], retailExpressFixture);
    await runCli(["stocktake", "count", "124001", "6"], retailExpressFixture);
    // Creating a directory where audit.jsonl should be forces appendAudit to fail.
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

  it("reports WMS success when the submitted session cannot be cleared", async () => {
    await runCli(["stocktake", "begin", "--outlet", "3"], retailExpressFixture);
    await runCli(["stocktake", "count", "124001", "6"], retailExpressFixture);
    const sessionFile = activeSessionPath();

    const wms: WmsClientLike = {
      createStocktake: async () => {
        rmSync(sessionFile, { force: true });
        mkdirSync(sessionFile);
        writeFileSync(join(sessionFile, "blocker"), "keep directory non-empty");
        return { ok: true, result: "Success" };
      },
    };
    const submitted = await runCli(["stocktake", "submit"], retailExpressFixture, wms);

    expect(submitted.err).toBe("");
    expect(JSON.parse(submitted.out)).toMatchObject({
      ok: true,
      submitted: true,
      cleared: false,
      clear: {
        warning: "Stocktake was submitted, but the local session could not be cleared.",
      },
    });
  });

  it("reports a warning when abort cannot clear the local session", async () => {
    await runCli(["stocktake", "begin", "--outlet", "3"], retailExpressFixture);
    const sessionFile = activeSessionPath();
    rmSync(sessionFile, { force: true });
    mkdirSync(sessionFile);
    writeFileSync(join(sessionFile, "blocker"), "keep directory non-empty");

    const aborted = await runCli(["stocktake", "abort"], retailExpressFixture);

    expect(aborted.err).toBe("");
    expect(JSON.parse(aborted.out)).toMatchObject({
      ok: true,
      aborted: false,
      cleared: false,
      clear: {
        warning: "Stocktake abort could not clear the local session.",
      },
    });
  });
});
