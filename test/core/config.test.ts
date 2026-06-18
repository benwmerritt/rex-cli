import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_BASE_URL,
  DEFAULT_VERSION,
  loadConfig,
  parseConfig,
  resolveProfile,
  resolveStocktakeUserId,
  saveProfile,
  saveWmsProfile,
  setDefaultProfile,
} from "../../src/core/config";
import { ValidationError } from "../../src/core/errors";

let dir: string;
let configPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rex-cfg-"));
  configPath = join(dir, "config.toml");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const SAMPLE = `default_profile = "show-go"

[profiles.show-go]
api_key = "KEY_SG"
base_url = "https://api.retailexpress.com.au"
version = "v2.1"

[profiles.other]
api_key = "KEY_OTHER"
`;

describe("parseConfig", () => {
  it("reads default_profile and profiles", () => {
    const cfg = parseConfig(SAMPLE);
    expect(cfg.defaultProfile).toBe("show-go");
    expect(Object.keys(cfg.profiles).sort()).toEqual(["other", "show-go"]);
    expect(cfg.profiles["show-go"]?.api_key).toBe("KEY_SG");
  });

  it("tolerates an empty/absent config", () => {
    expect(loadConfig(join(dir, "missing.toml"))).toEqual({ profiles: {} });
  });
});

describe("resolveProfile precedence", () => {
  beforeEach(() => writeFileSync(configPath, SAMPLE));

  it("REX_API_KEY env overrides everything with a key-derived ephemeral profile", () => {
    const p = resolveProfile({
      env: {
        REX_API_KEY: "ENVKEY",
        REX_WMS_CLIENT_ID: "CID",
        REX_WMS_USERNAME: "wsi",
        REX_WMS_PASSWORD: "secret",
        REX_WMS_URL: "https://wms",
        REX_STOCKTAKE_USER_ID: "4",
      },
      configPath,
      cwd: dir,
    });
    expect(p).toMatchObject({
      apiKey: "ENVKEY",
      baseUrl: DEFAULT_BASE_URL,
      version: DEFAULT_VERSION,
      wmsClientId: "CID",
      wmsUsername: "wsi",
      wmsPassword: "secret",
      wmsUrl: "https://wms",
    });
    expect(resolveStocktakeUserId(p)).toBe(4);
    expect(p.name).toMatch(/^env-[a-f0-9]{12}$/);
    expect(p.name).not.toContain("ENVKEY");

    const sameKey = resolveProfile({ env: { REX_API_KEY: "ENVKEY" }, configPath, cwd: dir });
    const otherKey = resolveProfile({ env: { REX_API_KEY: "OTHER_ENVKEY" }, configPath, cwd: dir });
    expect(sameKey.name).toBe(p.name);
    expect(otherKey.name).not.toBe(p.name);
  });

  it("REX_PROFILE is namespaced by API key when REX_API_KEY env auth is used", () => {
    const p = resolveProfile({
      env: { REX_API_KEY: "ENVKEY", REX_PROFILE: "tenant-a" },
      configPath,
      cwd: dir,
    });
    const sameProfileOtherKey = resolveProfile({
      env: { REX_API_KEY: "OTHER_ENVKEY", REX_PROFILE: "tenant-a" },
      configPath,
      cwd: dir,
    });
    expect(p.name).toMatch(/^tenant-a-env-[a-f0-9]{12}$/);
    expect(p.name).not.toContain("ENVKEY");
    expect(sameProfileOtherKey.name).toMatch(/^tenant-a-env-[a-f0-9]{12}$/);
    expect(sameProfileOtherKey.name).not.toBe(p.name);
    expect(p.apiKey).toBe("ENVKEY");
  });

  it("--profile flag selects a named profile from config", () => {
    const p = resolveProfile({ profileFlag: "other", env: {}, configPath, cwd: dir });
    expect(p.name).toBe("other");
    expect(p.apiKey).toBe("KEY_OTHER");
    expect(p.baseUrl).toBe(DEFAULT_BASE_URL); // defaulted
  });

  it("REX_PROFILE env selects a named profile", () => {
    const p = resolveProfile({ env: { REX_PROFILE: "other" }, configPath, cwd: dir });
    expect(p.name).toBe("other");
  });

  it(".rex.toml in cwd pins the profile", () => {
    const proj = mkdtempSync(join(tmpdir(), "rex-proj-"));
    writeFileSync(join(proj, ".rex.toml"), 'profile = "other"\n');
    const p = resolveProfile({ env: {}, configPath, cwd: proj });
    expect(p.name).toBe("other");
    rmSync(proj, { recursive: true, force: true });
  });

  it("falls back to default_profile", () => {
    const p = resolveProfile({ env: {}, configPath, cwd: dir });
    expect(p.name).toBe("show-go");
  });

  it("throws when no profile can be resolved", () => {
    writeFileSync(configPath, "");
    expect(() => resolveProfile({ env: {}, configPath, cwd: dir })).toThrow(ValidationError);
  });

  it("throws when the selected profile is missing its api_key", () => {
    writeFileSync(configPath, "[profiles.broken]\nbase_url = \"x\"\n");
    expect(() => resolveProfile({ profileFlag: "broken", env: {}, configPath, cwd: dir })).toThrow(
      ValidationError,
    );
  });

  it("defers stocktake user id env validation until stocktake code needs it", () => {
    const p = resolveProfile({
      env: { REX_API_KEY: "ENVKEY", REX_STOCKTAKE_USER_ID: "-1" },
      configPath,
      cwd: dir,
    });
    expect(p.apiKey).toBe("ENVKEY");
    expect(() => resolveStocktakeUserId(p)).toThrow("REX_STOCKTAKE_USER_ID must be a positive integer.");
  });

  it("reports zero stocktake user id env values as positive integers", () => {
    const p = resolveProfile({
      env: { REX_API_KEY: "ENVKEY", REX_STOCKTAKE_USER_ID: "0" },
      configPath,
      cwd: dir,
    });
    expect(() => resolveStocktakeUserId(p)).toThrow("REX_STOCKTAKE_USER_ID must be a positive integer.");
  });

  it("reports stocktake user id env values above the safe integer limit as out of range", () => {
    const p = resolveProfile({
      env: { REX_API_KEY: "ENVKEY", REX_STOCKTAKE_USER_ID: "9007199254740992" },
      configPath,
      cwd: dir,
    });
    expect(() => resolveStocktakeUserId(p)).toThrow(
      "REX_STOCKTAKE_USER_ID is out of range; must not exceed Number.MAX_SAFE_INTEGER.",
    );
  });
});

describe("saveProfile / setDefaultProfile", () => {
  it("round-trips a profile, sets the first as default, and writes 0600", () => {
    saveProfile({ name: "show-go", apiKey: "K1" }, configPath);
    const cfg = loadConfig(configPath);
    expect(cfg.defaultProfile).toBe("show-go");
    expect(cfg.profiles["show-go"]?.api_key).toBe("K1");
    expect(cfg.profiles["show-go"]?.base_url).toBe(DEFAULT_BASE_URL);

    const mode = statSync(configPath).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("accepts safe profile names with allowed characters", () => {
    saveProfile({ name: "tenant-a.env_1", apiKey: "K1" }, configPath);
    const cfg = loadConfig(configPath);
    expect(cfg.defaultProfile).toBe("tenant-a.env_1");
    expect(cfg.profiles["tenant-a.env_1"]?.api_key).toBe("K1");
  });

  it("rejects unsafe profile names before saving", () => {
    for (const profile of ["", ".", "..", "../tenant", "tenant/one", "tenant\\one", "tenant..one", "tenant one", "tenant:one"]) {
      expect(() => saveProfile({ name: profile, apiKey: "K1" }, configPath)).toThrow(ValidationError);
      expect(loadConfig(configPath)).toEqual({ profiles: {} });
    }
  });

  it("does not clobber the default when adding a second profile", () => {
    saveProfile({ name: "a", apiKey: "K1" }, configPath);
    saveProfile({ name: "b", apiKey: "K2" }, configPath);
    expect(loadConfig(configPath).defaultProfile).toBe("a");
  });

  it("setDefaultProfile updates an existing profile and rejects unknown ones", () => {
    saveProfile({ name: "a", apiKey: "K1" }, configPath);
    saveProfile({ name: "b", apiKey: "K2" }, configPath);
    setDefaultProfile("b", configPath);
    expect(loadConfig(configPath).defaultProfile).toBe("b");
    expect(() => setDefaultProfile("ghost", configPath)).toThrow(ValidationError);
  });

  it("adds WMS SOAP credentials to an existing REST profile", () => {
    saveProfile({ name: "a", apiKey: "K1" }, configPath);
    saveWmsProfile(
      {
        name: "a",
        clientId: "CID",
        username: "wsi",
        password: "secret",
        url: "https://wms/service.asmx?wsdl",
        stocktakeUserId: 4,
      },
      configPath,
    );
    const p = resolveProfile({ profileFlag: "a", env: {}, configPath, cwd: dir });
    expect(p).toMatchObject({
      apiKey: "K1",
      wmsClientId: "CID",
      wmsUsername: "wsi",
      wmsPassword: "secret",
      wmsUrl: "https://wms/service.asmx?wsdl",
      stocktakeUserId: 4,
    });
  });

  it("clears only the WMS stocktake user id when saveWmsProfile receives null", () => {
    saveProfile({ name: "a", apiKey: "K1" }, configPath);
    saveWmsProfile(
      {
        name: "a",
        clientId: "CID",
        username: "wsi",
        password: "secret",
        url: "https://wms/service.asmx?wsdl",
        stocktakeUserId: 4,
      },
      configPath,
    );

    saveWmsProfile(
      {
        name: "a",
        clientId: "CID2",
        username: "wsi2",
        password: "secret2",
        url: "https://wms2/service.asmx?wsdl",
        stocktakeUserId: null,
      },
      configPath,
    );

    expect(loadConfig(configPath).profiles.a).toMatchObject({
      api_key: "K1",
      wms_client_id: "CID2",
      wms_username: "wsi2",
      wms_password: "secret2",
      wms_url: "https://wms2/service.asmx?wsdl",
    });
    expect(loadConfig(configPath).profiles.a?.stocktake_user_id).toBeUndefined();
  });

  it("preserves WMS SOAP credentials when saving the same API key", () => {
    saveProfile({ name: "a", apiKey: "K1" }, configPath);
    saveWmsProfile(
      {
        name: "a",
        clientId: "CID",
        username: "wsi",
        password: "secret",
        url: "https://wms/service.asmx?wsdl",
        stocktakeUserId: 4,
      },
      configPath,
    );

    saveProfile({ name: "a", apiKey: "K1" }, configPath);

    expect(loadConfig(configPath).profiles.a).toMatchObject({
      api_key: "K1",
      wms_client_id: "CID",
      wms_username: "wsi",
      wms_password: "secret",
      wms_url: "https://wms/service.asmx?wsdl",
      stocktake_user_id: 4,
    });
  });

  it("clears WMS SOAP credentials when saving a different API key on the same profile", () => {
    saveProfile({ name: "a", apiKey: "K1" }, configPath);
    saveWmsProfile(
      {
        name: "a",
        clientId: "CID",
        username: "wsi",
        password: "secret",
        url: "https://wms/service.asmx?wsdl",
        stocktakeUserId: 4,
      },
      configPath,
    );

    saveProfile({ name: "a", apiKey: "K2" }, configPath);

    expect(loadConfig(configPath).profiles.a).toEqual({
      api_key: "K2",
      base_url: DEFAULT_BASE_URL,
      version: DEFAULT_VERSION,
    });
  });
});
