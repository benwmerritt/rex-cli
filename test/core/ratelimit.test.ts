import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRateLimiter } from "../../src/core/ratelimit";

let dir: string;
let statePath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rex-rl-"));
  statePath = join(dir, "rl.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A clock + sleep pair where sleeping advances the clock (no real time). */
function fakeClock(start = 0) {
  let clock = start;
  const sleeps: number[] = [];
  return {
    now: () => clock,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      clock += ms;
    },
    sleeps,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe("createRateLimiter", () => {
  it("allows up to maxPerMinute without sleeping", async () => {
    const c = fakeClock();
    const limiter = createRateLimiter({ profile: "p", maxPerMinute: 3, statePath, now: c.now, sleep: c.sleep });
    await limiter.acquire();
    await limiter.acquire();
    await limiter.acquire();
    expect(c.sleeps).toHaveLength(0);
  });

  it("blocks past the cap, then proceeds once the window rolls over", async () => {
    const c = fakeClock();
    const limiter = createRateLimiter({ profile: "p", maxPerMinute: 3, statePath, now: c.now, sleep: c.sleep });
    await limiter.acquire();
    await limiter.acquire();
    await limiter.acquire();
    await limiter.acquire(); // 4th must wait ~one window
    expect(c.sleeps).toHaveLength(1);
    expect(c.sleeps[0]).toBeGreaterThan(0);
    expect(c.sleeps[0]).toBeLessThanOrEqual(60_000);
  });

  it("shares one budget across separate limiter instances (same state file)", async () => {
    const c = fakeClock();
    const a = createRateLimiter({ profile: "p", maxPerMinute: 3, statePath, now: c.now, sleep: c.sleep });
    const b = createRateLimiter({ profile: "p", maxPerMinute: 3, statePath, now: c.now, sleep: c.sleep });
    await a.acquire();
    await a.acquire();
    await b.acquire();
    expect(c.sleeps).toHaveLength(0);
    await b.acquire(); // 4th across the shared budget must wait
    expect(c.sleeps).toHaveLength(1);
  });
});
