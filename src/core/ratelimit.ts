import { mkdirSync, readFileSync, rmdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { rateLimitFile } from "./paths";

export interface RateLimiter {
  /** Block until a request slot is available. */
  acquire(): Promise<void>;
}

/** No-op limiter for tests and `rex api` low-volume paths. */
export const noopLimiter: RateLimiter = { acquire: async () => {} };

export interface RateLimiterOptions {
  profile: string;
  /** Requests per rolling minute. Default 250 (headroom under the 300 ceiling). */
  maxPerMinute?: number;
  /** Override the shared state file (tests). */
  statePath?: string;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Max attempts to grab the cross-process lock before proceeding best-effort. */
  lockAttempts?: number;
}

interface Window {
  windowStart: number;
  count: number;
}

const WINDOW_MS = 60_000;

/**
 * A cross-process rolling-minute budget. The key constraint: many `rex`
 * processes (a fan-out workflow, an agent loop) share one Retail Express
 * client and one 300/min ceiling, so a per-process counter is not enough. This
 * keeps the counter in a small JSON file guarded by an atomic mkdir lock, so N
 * concurrent processes draw from a single budget. It is best-effort — if the
 * lock can't be grabbed it proceeds — and 429 handling in the client remains
 * the authoritative backstop.
 */
export function createRateLimiter(opts: RateLimiterOptions): RateLimiter {
  const max = opts.maxPerMinute ?? 250;
  const statePath = opts.statePath ?? rateLimitFile(opts.profile);
  const lockPath = `${statePath}.lock`;
  const now = opts.now ?? (() => Date.now());
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const lockAttempts = opts.lockAttempts ?? 100;

  function readWindow(): Window {
    try {
      const w = JSON.parse(readFileSync(statePath, "utf8")) as Partial<Window>;
      if (typeof w.windowStart === "number" && typeof w.count === "number") {
        return { windowStart: w.windowStart, count: w.count };
      }
    } catch {
      // missing/corrupt → fresh window
    }
    return { windowStart: now(), count: 0 };
  }

  async function withLock<T>(fn: () => T): Promise<T> {
    mkdirSync(dirname(statePath), { recursive: true, mode: 0o700 });
    for (let attempt = 0; attempt < lockAttempts; attempt++) {
      try {
        mkdirSync(lockPath); // atomic create; throws EEXIST if held
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "EEXIST") {
          await sleep(5);
          continue;
        }
        throw err;
      }
      try {
        return fn();
      } finally {
        try {
          rmdirSync(lockPath);
        } catch {
          // ignore
        }
      }
    }
    return fn(); // best-effort: proceed without the lock rather than stall forever
  }

  return {
    async acquire(): Promise<void> {
      for (;;) {
        const waitMs = await withLock<number>(() => {
          const t = now();
          let w = readWindow();
          if (t - w.windowStart >= WINDOW_MS) w = { windowStart: t, count: 0 };
          if (w.count < max) {
            w.count += 1;
            writeFileSync(statePath, JSON.stringify(w), { mode: 0o600 });
            return 0;
          }
          return w.windowStart + WINDOW_MS - t;
        });
        if (waitMs <= 0) return;
        await sleep(waitMs);
      }
    },
  };
}
