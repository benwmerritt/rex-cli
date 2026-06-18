import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAuth } from "../../src/core/auth";
import { AuthError } from "../../src/core/errors";
import type { Transport } from "../../src/core/transport";

let dir: string;
let cachePath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rex-auth-"));
  cachePath = join(dir, "tok.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** A transport that returns queued responses and records each call. */
function recordingTransport(responses: Array<() => Response>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let i = 0;
  const transport: Transport = async (url, init) => {
    calls.push({ url, init });
    const make = responses[Math.min(i, responses.length - 1)];
    i++;
    return make!();
  };
  return { transport, calls };
}

const HOUR = 60 * 60_000;

describe("createAuth", () => {
  it("fetches a token cold, hits the right URL + header, and caches 0600 to disk", async () => {
    const t0 = 1_000_000;
    const { transport, calls } = recordingTransport([
      () => jsonResponse({ token_type: "Bearer", access_token: "AT1", expires_on: new Date(t0 + HOUR).toISOString() }),
    ]);
    const auth = createAuth({
      apiKey: "KEY", baseUrl: "https://api.retailexpress.com.au", version: "v2.1",
      profile: "p", transport, now: () => t0, cachePath,
    });

    expect(await auth.ensureToken()).toBe("AT1");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.retailexpress.com.au/v2/auth/token");
    expect((calls[0]!.init.headers as Record<string, string>)["x-api-key"]).toBe("KEY");
    expect(calls[0]!.init.method).toBe("GET");

    expect(existsSync(cachePath)).toBe(true);
    expect(statSync(cachePath).mode & 0o777).toBe(0o600);
    const cached = JSON.parse(readFileSync(cachePath, "utf8"));
    expect(cached.accessToken).toBe("AT1");
  });

  it("reuses the in-memory token without re-fetching", async () => {
    const t0 = 1_000_000;
    const { transport, calls } = recordingTransport([
      () => jsonResponse({ access_token: "AT1", expires_on: new Date(t0 + HOUR).toISOString() }),
    ]);
    const auth = createAuth({ apiKey: "K", baseUrl: "b", version: "v2.1", profile: "p", transport, now: () => t0, cachePath });
    await auth.ensureToken();
    await auth.ensureToken();
    expect(calls).toHaveLength(1);
  });

  it("reuses a valid disk cache from a fresh instance (no fetch)", async () => {
    const t0 = 1_000_000;
    const seed = recordingTransport([
      () => jsonResponse({ access_token: "AT1", expires_on: new Date(t0 + HOUR).toISOString() }),
    ]);
    await createAuth({ apiKey: "K", baseUrl: "b", version: "v2.1", profile: "p", transport: seed.transport, now: () => t0, cachePath }).ensureToken();

    const fresh = recordingTransport([() => jsonResponse({ access_token: "SHOULD_NOT_FETCH" })]);
    const token = await createAuth({ apiKey: "K", baseUrl: "b", version: "v2.1", profile: "p", transport: fresh.transport, now: () => t0 + 60_000, cachePath }).ensureToken();
    expect(token).toBe("AT1");
    expect(fresh.calls).toHaveLength(0);
  });

  it("refreshes when the cached token is within the skew window", async () => {
    const t0 = 1_000_000;
    let clock = t0;
    const { transport, calls } = recordingTransport([
      () => jsonResponse({ access_token: "AT1", expires_on: new Date(t0 + HOUR).toISOString() }),
      () => jsonResponse({ access_token: "AT2", expires_on: new Date(t0 + 2 * HOUR).toISOString() }),
    ]);
    const auth = createAuth({ apiKey: "K", baseUrl: "b", version: "v2.1", profile: "p", transport, now: () => clock, cachePath });
    expect(await auth.ensureToken()).toBe("AT1");
    // jump to 2 minutes before expiry (inside the 5-min skew)
    clock = t0 + HOUR - 2 * 60_000;
    expect(await auth.ensureToken()).toBe("AT2");
    expect(calls).toHaveLength(2);
  });

  it("invalidate() drops memory + disk and forces a refetch", async () => {
    const t0 = 1_000_000;
    const { transport, calls } = recordingTransport([
      () => jsonResponse({ access_token: "AT1", expires_on: new Date(t0 + HOUR).toISOString() }),
      () => jsonResponse({ access_token: "AT2", expires_on: new Date(t0 + HOUR).toISOString() }),
    ]);
    const auth = createAuth({ apiKey: "K", baseUrl: "b", version: "v2.1", profile: "p", transport, now: () => t0, cachePath });
    await auth.ensureToken();
    auth.invalidate();
    expect(existsSync(cachePath)).toBe(false);
    expect(await auth.ensureToken()).toBe("AT2");
    expect(calls).toHaveLength(2);
  });

  it("falls back to a conservative TTL when expires_on is missing/unparseable", async () => {
    const t0 = 1_000_000;
    const { transport, calls } = recordingTransport([
      () => jsonResponse({ access_token: "AT1" }), // no expires_on
    ]);
    const auth = createAuth({ apiKey: "K", baseUrl: "b", version: "v2.1", profile: "p", transport, now: () => t0, cachePath });
    expect(await auth.ensureToken()).toBe("AT1");
    // still valid a few minutes later → no second fetch
    expect(await auth.ensureToken()).toBe("AT1");
    expect(calls).toHaveLength(1);
  });

  it("throws AuthError on a non-OK token response", async () => {
    const { transport } = recordingTransport([() => jsonResponse({ message: "denied" }, 401)]);
    const auth = createAuth({ apiKey: "K", baseUrl: "b", version: "v2.1", profile: "p", transport, now: () => 0, cachePath });
    await expect(auth.ensureToken()).rejects.toBeInstanceOf(AuthError);
  });
});
