import { homedir } from "node:os";
import { join } from "node:path";
import { ValidationError } from "./errors";

/**
 * XDG-aware base directories for rex. These are functions (not constants) so
 * tests can override HOME / XDG_*_HOME via the environment per-case.
 */
function xdg(envVar: string, fallbackSegments: string[]): string {
  const base = process.env[envVar];
  if (base && base.length > 0) return join(base, "rex");
  return join(homedir(), ...fallbackSegments, "rex");
}

/** `~/.config/rex` (or `$XDG_CONFIG_HOME/rex`). Holds config.toml. */
export function configDir(): string {
  return xdg("XDG_CONFIG_HOME", [".config"]);
}

/** `~/.cache/rex` (or `$XDG_CACHE_HOME/rex`). Holds the bearer-token + rate-limit caches. */
export function cacheDir(): string {
  return xdg("XDG_CACHE_HOME", [".cache"]);
}

/** `~/.local/state/rex` (or `$XDG_STATE_HOME/rex`). Holds the write audit log. */
export function stateDir(): string {
  return xdg("XDG_STATE_HOME", [".local", "state"]);
}

export function configFile(): string {
  return join(configDir(), "config.toml");
}

export function tokenCacheFile(profile: string): string {
  return join(cacheDir(), `${profileFileStem(profile)}.token.json`);
}

export function rateLimitFile(profile: string): string {
  return join(cacheDir(), `${profileFileStem(profile)}.ratelimit.json`);
}

export function stocktakeSessionFile(profile: string): string {
  return join(stateDir(), `stocktake.${profileFileStem(profile)}.json`);
}

function profileFileStem(profile: string): string {
  if (
    profile.length === 0 ||
    profile === "." ||
    profile === ".." ||
    profile.includes("..") ||
    profile.includes("/") ||
    profile.includes("\\") ||
    !/^[A-Za-z0-9._-]+$/.test(profile)
  ) {
    throw new ValidationError("Unsafe profile name for filesystem path.", {
      details: {
        profile,
        allowed: "letters, numbers, dot, underscore, and hyphen",
      },
    });
  }
  return profile;
}
