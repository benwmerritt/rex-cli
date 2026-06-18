import { describe, expect, it } from "bun:test";
import type { AuthProvider } from "../../src/core/auth";
import { RexClient } from "../../src/core/client";
import { ApiError, AuthError, NotFoundError, RateLimitError } from "../../src/core/errors";
import type { Transport } from "../../src/core/transport";

function res(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  const init: ResponseInit = { status, headers: { "content-type": "application/json", ...headers } };
  return new Response(body === undefined ? null : JSON.stringify(body), init);
}

function fakeAuth(tokens: string[] = ["T1", "T2", "T3"]) {
  const state = { ensureCalls: 0, invalidated: 0 };
  const provider: AuthProvider = {
    ensureToken: async () => tokens[Math.min(state.ensureCalls++, tokens.length - 1)]!,
    invalidate: () => {
      state.invalidated += 1;
    },
  };
  return { provider, state };
}

function recording(responses: Array<() => Response>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let i = 0;
  const transport: Transport = async (url, init) => {
    calls.push({ url, init });
    return responses[Math.min(i++, responses.length - 1)]!();
  };
  return { transport, calls };
}

const NO_SLEEP = async () => {};

function client(transport: Transport, auth: AuthProvider, overrides = {}) {
  return new RexClient({
    baseUrl: "https://api.retailexpress.com.au",
    version: "v2.1",
    apiKey: "KEY",
    auth,
    transport,
    sleep: NO_SLEEP,
    now: () => 0,
    ...overrides,
  });
}

describe("RexClient.request", () => {
  it("sends auth + x-api-key headers and parses JSON on success", async () => {
    const { transport, calls } = recording([() => res({ id: 7, name: "Widget" })]);
    const auth = fakeAuth();
    const out = await client(transport, auth.provider).get("products/7");
    expect(out).toEqual({ id: 7, name: "Widget" });
    const h = calls[0]!.init.headers as Record<string, string>;
    expect(h["Authorization"]).toBe("Bearer T1");
    expect(h["x-api-key"]).toBe("KEY");
    expect(calls[0]!.url).toBe("https://api.retailexpress.com.au/v2.1/products/7");
  });

  it("builds query strings, skipping undefined/null", async () => {
    const { transport, calls } = recording([() => res({ nodes: [] })]);
    await client(transport, fakeAuth().provider).get("products", {
      query: { page_size: 250, search: "blue", disabled: undefined },
    });
    expect(calls[0]!.url).toBe("https://api.retailexpress.com.au/v2.1/products?page_size=250&search=blue");
  });

  it("refreshes the token and retries once on 401", async () => {
    const { transport, calls } = recording([() => res({ error: "expired" }, 401), () => res({ ok: true })]);
    const auth = fakeAuth();
    const out = await client(transport, auth.provider).get<{ ok: boolean }>("products");
    expect(out).toEqual({ ok: true });
    expect(calls).toHaveLength(2);
    expect(auth.state.invalidated).toBe(1);
    expect(auth.state.ensureCalls).toBe(2); // second call gets a fresh token
  });

  it("throws AuthError after a second consecutive 401", async () => {
    const { transport } = recording([() => res({}, 401)]);
    await expect(client(transport, fakeAuth().provider).get("products")).rejects.toBeInstanceOf(AuthError);
  });

  it("does not retry a 403 (permission)", async () => {
    const { transport, calls } = recording([() => res({}, 403)]);
    await expect(client(transport, fakeAuth().provider).get("products")).rejects.toBeInstanceOf(AuthError);
    expect(calls).toHaveLength(1);
  });

  it("maps 404 to NotFoundError", async () => {
    const { transport } = recording([() => res({}, 404)]);
    await expect(client(transport, fakeAuth().provider).get("products/9")).rejects.toBeInstanceOf(NotFoundError);
  });

  it("honours Retry-After on 429 then succeeds", async () => {
    const { transport, calls } = recording([
      () => res({}, 429, { "retry-after": "1" }),
      () => res({ ok: true }),
    ]);
    const out = await client(transport, fakeAuth().provider).get<{ ok: boolean }>("products");
    expect(out).toEqual({ ok: true });
    expect(calls).toHaveLength(2);
  });

  it("throws RateLimitError once retries are exhausted", async () => {
    const { transport } = recording([() => res({}, 429)]);
    await expect(
      client(transport, fakeAuth().provider, { maxRetries: 1 }).get("products"),
    ).rejects.toBeInstanceOf(RateLimitError);
  });

  it("retries a 5xx on GET (idempotent) then succeeds", async () => {
    const { transport, calls } = recording([() => res({}, 503), () => res({ ok: true })]);
    const out = await client(transport, fakeAuth().provider).get<{ ok: boolean }>("inventory");
    expect(out).toEqual({ ok: true });
    expect(calls).toHaveLength(2);
  });

  it("does NOT retry a 5xx on POST (no idempotency key in REX)", async () => {
    const { transport, calls } = recording([() => res({}, 503)]);
    await expect(
      client(transport, fakeAuth().provider).request("POST", "products", { body: { x: 1 } }),
    ).rejects.toBeInstanceOf(ApiError);
    expect(calls).toHaveLength(1);
  });

  it("sends a JSON body + Content-Type on writes", async () => {
    const { transport, calls } = recording([() => res({ id: 1 })]);
    await client(transport, fakeAuth().provider).request("PUT", "products/1", { body: { name: "x" } });
    const h = calls[0]!.init.headers as Record<string, string>;
    expect(h["Content-Type"]).toBe("application/json");
    expect(calls[0]!.init.body).toBe('{"name":"x"}');
  });
});
