import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadDotenv, parseLine } from "../../src/core/dotenv";

describe("parseLine", () => {
  it("parses KEY=VALUE, strips quotes and `export`, skips comments/blanks", () => {
    expect(parseLine("REX_API_KEY=abc")).toEqual({ key: "REX_API_KEY", value: "abc" });
    expect(parseLine('export REX_API_KEY="abc"')).toEqual({ key: "REX_API_KEY", value: "abc" });
    expect(parseLine("REX_PROFILE='show-go'")).toEqual({ key: "REX_PROFILE", value: "show-go" });
    expect(parseLine("# comment")).toBeUndefined();
    expect(parseLine("   ")).toBeUndefined();
    expect(parseLine("noequals")).toBeUndefined();
  });
});

describe("loadDotenv", () => {
  let dir: string;
  beforeEach(() => (dir = mkdtempSync(join(tmpdir(), "rex-env-"))));
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("loads keys from a .env found by walking up, without overriding real env", () => {
    const nested = join(dir, "a", "b");
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(dir, ".env"), "REX_API_KEY=fromfile\nREX_PROFILE=show-go\n");
    const env: NodeJS.ProcessEnv = { REX_PROFILE: "already-set" };
    loadDotenv(nested, env);
    expect(env.REX_API_KEY).toBe("fromfile"); // picked up from a parent dir
    expect(env.REX_PROFILE).toBe("already-set"); // real env wins
  });

  it("is a no-op when no .env exists", () => {
    const env: NodeJS.ProcessEnv = {};
    loadDotenv(dir, env);
    expect(env.REX_API_KEY).toBeUndefined();
  });
});
