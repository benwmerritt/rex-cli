import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ValidationError } from "../../src/core/errors";
import { rateLimitFile, stocktakeSessionFile, tokenCacheFile } from "../../src/core/paths";

let cacheHome: string;
let stateHome: string;
let previousCacheHome: string | undefined;
let previousStateHome: string | undefined;

beforeEach(() => {
  previousCacheHome = process.env.XDG_CACHE_HOME;
  previousStateHome = process.env.XDG_STATE_HOME;
  cacheHome = mkdtempSync(join(tmpdir(), "rex-path-cache-"));
  stateHome = mkdtempSync(join(tmpdir(), "rex-path-state-"));
  process.env.XDG_CACHE_HOME = cacheHome;
  process.env.XDG_STATE_HOME = stateHome;
});

afterEach(() => {
  if (previousCacheHome === undefined) delete process.env.XDG_CACHE_HOME;
  else process.env.XDG_CACHE_HOME = previousCacheHome;
  if (previousStateHome === undefined) delete process.env.XDG_STATE_HOME;
  else process.env.XDG_STATE_HOME = previousStateHome;
  rmSync(cacheHome, { recursive: true, force: true });
  rmSync(stateHome, { recursive: true, force: true });
});

describe("profile-backed paths", () => {
  it("uses safe profile names in cache and state filenames", () => {
    expect(tokenCacheFile("tenant-a.env_1")).toBe(join(cacheHome, "rex", "tenant-a.env_1.token.json"));
    expect(rateLimitFile("tenant-a.env_1")).toBe(join(cacheHome, "rex", "tenant-a.env_1.ratelimit.json"));
    expect(stocktakeSessionFile("tenant-a.env_1")).toBe(join(stateHome, "rex", "stocktake.tenant-a.env_1.json"));
  });

  it("rejects unsafe profile names before constructing filenames", () => {
    for (const profile of ["", ".", "..", "../tenant", "tenant/one", "tenant\\one", "tenant..one", "tenant one", "tenant:one"]) {
      expect(() => tokenCacheFile(profile)).toThrow(ValidationError);
      expect(() => rateLimitFile(profile)).toThrow(ValidationError);
      expect(() => stocktakeSessionFile(profile)).toThrow(ValidationError);
    }
  });
});
