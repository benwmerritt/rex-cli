import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildProgram } from "../../src/cli/program";
import { saveProfile } from "../../src/core/config";
import { Output } from "../../src/core/output";
import { capture } from "../helpers/capture";

let configHome: string;
let previousConfigHome: string | undefined;

const WMS_ENV = {
  REX_WMS_CLIENT_ID: "CID",
  REX_WMS_USERNAME: "wsi",
  REX_WMS_PASSWORD: "secret",
  REX_WMS_URL: "https://wms.example.test/service.asmx",
};

beforeEach(() => {
  previousConfigHome = process.env.XDG_CONFIG_HOME;
  configHome = mkdtempSync(join(tmpdir(), "rex-doctor-"));
  process.env.XDG_CONFIG_HOME = configHome;
  process.exitCode = 0;
});

afterEach(() => {
  if (previousConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = previousConfigHome;
  rmSync(configHome, { recursive: true, force: true });
  process.exitCode = 0;
});

async function runCli(argv: string[], env: NodeJS.ProcessEnv = {}) {
  const out = capture();
  const err = capture();
  const program = buildProgram({ env, output: new Output({ mode: "json" }, out.writer, err.writer) });
  program.exitOverride();
  await program.parseAsync(["node", "rex", ...argv]);
  return { out: out.text(), err: err.text() };
}

describe("rex doctor", () => {
  it("reports stocktake submit as blocked and names what would unblock it", async () => {
    const result = await runCli(["doctor"], { REX_API_KEY: "K", REX_PROFILE: "test" });

    expect(result.err).toBe("");
    const report = JSON.parse(result.out);
    expect(report.credentials.wmsSoap.configured).toBe(false);
    expect(report.credentials.wmsSoap.missing).toHaveLength(4);
    expect(report.blocked).toEqual(["stocktake.submit"]);
    expect(report.capabilities["stocktake.submit"].status).toBe("blocked");
    expect(report.capabilities["stocktake.count"].status).toBe("available");
    expect(report.nextSteps.join(" ")).toContain("--local");
  });

  it("reports everything available once WMS credentials and a user id are present", async () => {
    const result = await runCli(["doctor"], {
      REX_API_KEY: "K",
      REX_PROFILE: "test",
      REX_STOCKTAKE_USER_ID: "42",
      ...WMS_ENV,
    });

    const report = JSON.parse(result.out);
    expect(report.blocked).toEqual([]);
    expect(report.credentials.stocktakeUserId).toMatchObject({ configured: true, userId: 42 });
    expect(report.nextSteps).toEqual([]);
  });

  it("separates a missing user id from missing WMS credentials", async () => {
    const result = await runCli(["doctor"], { REX_API_KEY: "K", REX_PROFILE: "test", ...WMS_ENV });

    const report = JSON.parse(result.out);
    expect(report.credentials.wmsSoap.configured).toBe(true);
    expect(report.capabilities["stocktake.submit"]).toMatchObject({
      status: "blocked",
      blockedBy: ["stocktake_user_id / REX_STOCKTAKE_USER_ID"],
    });
  });

  it("does not tell a REX_API_KEY user to run `rex config wms`, which that profile never reads", async () => {
    const result = await runCli(["doctor"], { REX_API_KEY: "K", REX_PROFILE: "test" });

    const report = JSON.parse(result.out);
    expect(report.profileSource).toBe("env");
    const remedy = report.capabilities["stocktake.submit"].remedy;
    expect(remedy).not.toContain("rex config wms");
    expect(remedy).toContain("REX_WMS_CLIENT_ID");
    expect(remedy).toContain("config.toml is ignored");
  });

  it("points a stored profile at `rex config wms`", async () => {
    saveProfile({ name: "stored", apiKey: "K" });

    const result = await runCli(["doctor"], { REX_PROFILE: "stored" });

    const report = JSON.parse(result.out);
    expect(report.profileSource).toBe("config");
    expect(report.capabilities["stocktake.submit"].remedy).toBe(
      "rex config wms stored --client-id <guid> --username <name> --password <password> --url <url>",
    );
  });

  it("fails like any other command when no profile resolves", async () => {
    const result = await runCli(["doctor"], {});

    expect(result.out).toBe("");
    expect(JSON.parse(result.err).error.code).toBe("validation");
    process.exitCode = 0;
  });
});
