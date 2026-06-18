import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildProgram } from "../../src/cli/program";
import { loadConfig, saveProfile } from "../../src/core/config";
import { Output, type Writer } from "../../src/core/output";

let configHome: string;
let previousConfigHome: string | undefined;

beforeEach(() => {
  previousConfigHome = process.env.XDG_CONFIG_HOME;
  configHome = mkdtempSync(join(tmpdir(), "rex-config-command-"));
  process.env.XDG_CONFIG_HOME = configHome;
  process.exitCode = 0;
});

afterEach(() => {
  if (previousConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = previousConfigHome;
  rmSync(configHome, { recursive: true, force: true });
  process.exitCode = 0;
});

function capture() {
  const chunks: string[] = [];
  const writer: Writer = { write: (s) => void chunks.push(s) };
  return { writer, text: () => chunks.join("") };
}

async function runCli(argv: string[], env: NodeJS.ProcessEnv = {}) {
  const out = capture();
  const err = capture();
  const program = buildProgram({
    env,
    output: new Output({ mode: "json" }, out.writer, err.writer),
  });
  program.exitOverride();
  await program.parseAsync(["node", "rex", ...argv]);
  return { out: out.text(), err: err.text() };
}

describe("rex config wms", () => {
  it("stores WMS credentials from environment fallbacks", async () => {
    saveProfile({ name: "default", apiKey: "K" });

    const result = await runCli(["config", "wms", "default", "--stocktake-user-id", "4"], {
      REX_WMS_CLIENT_ID: "CID",
      REX_WMS_USERNAME: "wsi",
      REX_WMS_PASSWORD: "secret",
      REX_WMS_URL: "https://wms/service.asmx?wsdl",
    });

    expect(JSON.parse(result.out)).toMatchObject({ ok: true, profile: "default", wms: true });
    expect(loadConfig().profiles.default).toMatchObject({
      api_key: "K",
      wms_client_id: "CID",
      wms_username: "wsi",
      wms_password: "secret",
      wms_url: "https://wms/service.asmx?wsdl",
      stocktake_user_id: 4,
    });
  });

  it("reports missing WMS fields as flag or env choices", async () => {
    saveProfile({ name: "default", apiKey: "K" });

    const result = await runCli(["config", "wms", "default"], {
      REX_WMS_CLIENT_ID: "CID",
    });

    const error = JSON.parse(result.err).error;
    expect(error.code).toBe("validation");
    expect(error.details.missing).toEqual([
      "--username or REX_WMS_USERNAME",
      "--password or REX_WMS_PASSWORD",
      "--url or REX_WMS_URL",
    ]);
    process.exitCode = 0;
  });
});
