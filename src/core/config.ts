import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { ValidationError } from "./errors";
import { configDir, configFile } from "./paths";
import { parseOptionalPositiveInt, validateSafeProfileName } from "./validation";

export const DEFAULT_BASE_URL = "https://api.retailexpress.com.au";
export const DEFAULT_VERSION = "v2.1";

/** A resolved, ready-to-use profile (every field populated). */
export interface Profile {
  name: string;
  apiKey: string;
  baseUrl: string;
  version: string;
  wmsClientId?: string;
  wmsUsername?: string;
  wmsPassword?: string;
  wmsUrl?: string;
  stocktakeUserId?: number;
  stocktakeUserIdEnv?: string;
}

/** A profile as stored in config.toml (fields optional; defaults applied on resolve). */
export interface RawProfile {
  api_key?: string;
  base_url?: string;
  version?: string;
  wms_client_id?: string;
  wms_username?: string;
  wms_password?: string;
  wms_url?: string;
  stocktake_user_id?: number;
}

export interface RexConfig {
  defaultProfile?: string;
  profiles: Record<string, RawProfile>;
}

export function parseConfig(text: string): RexConfig {
  const data = parseToml(text) as Record<string, unknown>;
  const profiles =
    data.profiles && typeof data.profiles === "object"
      ? (data.profiles as Record<string, RawProfile>)
      : {};
  const defaultProfile =
    typeof data.default_profile === "string" ? data.default_profile : undefined;
  return { defaultProfile, profiles };
}

export function loadConfig(path: string = configFile()): RexConfig {
  if (!existsSync(path)) return { profiles: {} };
  return parseConfig(readFileSync(path, "utf8"));
}

/** Walk up from `startDir` looking for a `.rex.toml` that pins `profile = "..."`. */
export function findProjectProfileName(startDir: string = process.cwd()): string | undefined {
  let dir = startDir;
  for (;;) {
    const candidate = join(dir, ".rex.toml");
    if (existsSync(candidate)) {
      const data = parseToml(readFileSync(candidate, "utf8")) as Record<string, unknown>;
      if (typeof data.profile === "string" && data.profile.length > 0) return data.profile;
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

export interface ResolveOptions {
  /** `--profile` flag. */
  profileFlag?: string;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  config?: RexConfig;
  configPath?: string;
}

function envProfileName(apiKey: string, profileName?: string): string {
  const digest = createHash("sha256").update(apiKey).digest("hex").slice(0, 12);
  return profileName ? `${profileName}-env-${digest}` : `env-${digest}`;
}

/**
 * Resolve the active profile. Precedence:
 *   1. `REX_API_KEY` env — a raw-key override that bypasses config entirely.
 *   2. Otherwise select a profile NAME by: `--profile` > `REX_PROFILE` env >
 *      `.rex.toml` (cwd and parents) > `default_profile`, then load it from config.
 */
export function resolveProfile(opts: ResolveOptions = {}): Profile {
  const env = opts.env ?? process.env;

  const envKey = env.REX_API_KEY?.trim();
  if (envKey) {
    const envProfile = env.REX_PROFILE?.trim() || undefined;
    return {
      name: envProfileName(envKey, envProfile),
      apiKey: envKey,
      baseUrl: env.REX_BASE_URL?.trim() || DEFAULT_BASE_URL,
      version: env.REX_VERSION?.trim() || DEFAULT_VERSION,
      wmsClientId: env.REX_WMS_CLIENT_ID?.trim() || undefined,
      wmsUsername: env.REX_WMS_USERNAME?.trim() || undefined,
      wmsPassword: env.REX_WMS_PASSWORD?.trim() || undefined,
      wmsUrl: env.REX_WMS_URL?.trim() || undefined,
      stocktakeUserIdEnv: env.REX_STOCKTAKE_USER_ID,
    };
  }

  const config = opts.config ?? loadConfig(opts.configPath);
  const name =
    opts.profileFlag?.trim() ||
    env.REX_PROFILE?.trim() ||
    findProjectProfileName(opts.cwd) ||
    config.defaultProfile;

  if (!name) {
    throw new ValidationError(
      "No Retail Express profile configured. Run `rex auth login` or set REX_API_KEY.",
      { details: { hint: "rex auth login --profile <name>" } },
    );
  }

  const raw = config.profiles[name];
  if (!raw || !raw.api_key) {
    throw new ValidationError(`Profile "${name}" not found or missing api_key.`, {
      details: { profile: name, available: Object.keys(config.profiles) },
    });
  }

  return {
    name,
    apiKey: raw.api_key,
    baseUrl: raw.base_url?.trim() || DEFAULT_BASE_URL,
    version: raw.version?.trim() || DEFAULT_VERSION,
    wmsClientId: raw.wms_client_id?.trim() || env.REX_WMS_CLIENT_ID?.trim() || undefined,
    wmsUsername: raw.wms_username?.trim() || env.REX_WMS_USERNAME?.trim() || undefined,
    wmsPassword: raw.wms_password?.trim() || env.REX_WMS_PASSWORD?.trim() || undefined,
    wmsUrl: raw.wms_url?.trim() || env.REX_WMS_URL?.trim() || undefined,
    stocktakeUserId: raw.stocktake_user_id,
    stocktakeUserIdEnv: raw.stocktake_user_id === undefined ? env.REX_STOCKTAKE_USER_ID : undefined,
  };
}

export function resolveStocktakeUserId(profile: Profile): number | undefined {
  return profile.stocktakeUserId ?? parseOptionalPositiveInt(profile.stocktakeUserIdEnv, "REX_STOCKTAKE_USER_ID");
}

/** Write config atomically with 0600 perms (temp file + rename). */
export function writeConfig(config: RexConfig, path: string = configFile()): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const doc: Record<string, unknown> = {};
  if (config.defaultProfile) doc.default_profile = config.defaultProfile;
  doc.profiles = config.profiles;
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, stringifyToml(doc), { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

export interface SaveProfileInput {
  name: string;
  apiKey: string;
  baseUrl?: string;
  version?: string;
}

export interface SaveWmsProfileInput {
  name: string;
  clientId: string;
  username: string;
  password: string;
  url: string;
  stocktakeUserId?: number | null;
}

/** Upsert a profile into config.toml. The first profile saved becomes the default. */
export function saveProfile(input: SaveProfileInput, configPath: string = configFile()): void {
  const profileName = validateSafeProfileName(input.name);
  const config = loadConfig(configPath);
  const existing = config.profiles[profileName];
  const apiKeyChanged = existing?.api_key !== undefined && existing.api_key !== input.apiKey;
  config.profiles[profileName] = {
    ...(apiKeyChanged ? withoutTenantScopedFields(existing) : existing),
    api_key: input.apiKey,
    base_url: input.baseUrl ?? DEFAULT_BASE_URL,
    version: input.version ?? DEFAULT_VERSION,
  };
  if (!config.defaultProfile) config.defaultProfile = profileName;
  writeConfig(config, configPath);
}

function withoutTenantScopedFields(profile: RawProfile | undefined): RawProfile | undefined {
  if (!profile) return undefined;
  const {
    wms_client_id: _wmsClientId,
    wms_username: _wmsUsername,
    wms_password: _wmsPassword,
    wms_url: _wmsUrl,
    stocktake_user_id: _stocktakeUserId,
    ...rest
  } = profile;
  return rest;
}

export function saveWmsProfile(input: SaveWmsProfileInput, configPath: string = configFile()): void {
  const profileName = validateSafeProfileName(input.name);
  const config = loadConfig(configPath);
  const existing = config.profiles[profileName];
  if (!existing?.api_key) {
    throw new ValidationError(`Profile "${profileName}" not found or missing api_key.`, {
      details: { profile: profileName, available: Object.keys(config.profiles) },
    });
  }
  const next: RawProfile = {
    ...existing,
    wms_client_id: input.clientId,
    wms_username: input.username,
    wms_password: input.password,
    wms_url: input.url,
  };
  if (input.stocktakeUserId === null) delete next.stocktake_user_id;
  else if (input.stocktakeUserId !== undefined) next.stocktake_user_id = input.stocktakeUserId;
  config.profiles[profileName] = next;
  writeConfig(config, configPath);
}

/** Set the default profile (errors if the profile isn't present). */
export function setDefaultProfile(name: string, configPath: string = configFile()): void {
  const config = loadConfig(configPath);
  if (!config.profiles[name]) {
    throw new ValidationError(`Profile "${name}" not found.`, {
      details: { available: Object.keys(config.profiles) },
    });
  }
  config.defaultProfile = name;
  writeConfig(config, configPath);
}

export { configDir };
