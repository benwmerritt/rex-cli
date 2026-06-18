import { describe, expect, it } from "bun:test";
import { buildProgram } from "../../src/cli/program";
import type { AuthProvider } from "../../src/core/auth";
import { RexClient } from "../../src/core/client";
import { Output, type Writer } from "../../src/core/output";
import type { Transport } from "../../src/core/transport";

const auth: AuthProvider = { ensureToken: async () => "T", invalidate: () => {} };

function fakeClient(handler: (method: string, url: string) => unknown) {
  const transport: Transport = async (url, init) =>
    new Response(JSON.stringify(handler(init.method ?? "GET", url)), {
      headers: { "content-type": "application/json" },
    });
  return new RexClient({
    baseUrl: "https://x",
    version: "v2.1",
    apiKey: "K",
    auth,
    transport,
    sleep: async () => {},
  });
}

function capture() {
  const chunks: string[] = [];
  const writer: Writer = { write: (s) => void chunks.push(s) };
  return { writer, text: () => chunks.join("") };
}

async function runCli(argv: string[], handler: (method: string, url: string) => unknown) {
  const out = capture();
  const err = capture();
  const program = buildProgram({
    env: { REX_API_KEY: "K" },
    clientFactory: () => fakeClient(handler),
    output: new Output({ mode: "json" }, out.writer, err.writer),
  });
  program.exitOverride();
  await program.parseAsync(["node", "rex", ...argv]);
  return { out: out.text(), err: err.text() };
}

describe("rex product (golden)", () => {
  it("get <id> prints the product as JSON", async () => {
    const { out } = await runCli(["product", "get", "5"], () => ({ id: 5, short_description: "Widget" }));
    expect(JSON.parse(out)).toEqual({ id: 5, short_description: "Widget" });
  });

  it("update --dry-run reports the diff and writes nothing", async () => {
    const { out } = await runCli(
      ["product", "update", "5", "--set", "short_description=New", "--dry-run"],
      (method) => {
        if (method !== "GET") throw new Error(`unexpected ${method} in dry-run`);
        return { id: 5, short_description: "Old", brand: "Acme" };
      },
    );
    const result = JSON.parse(out);
    expect(result).toMatchObject({
      id: 5,
      action: "update",
      changed: ["short_description"],
      dryRun: true,
      diff: { short_description: "New" },
    });
  });

  it("update gates a price change without --allow-price (exit 8)", async () => {
    const prevExit = process.exitCode;
    const { out, err } = await runCli(
      ["product", "update", "5", "--set", "web_price_inc=99"],
      () => ({ id: 5, web_price_inc: 10 }),
    );
    expect(out).toBe("");
    expect(JSON.parse(err).error.code).toBe("write_gated");
    expect(process.exitCode).toBe(8);
    process.exitCode = prevExit; // don't leak into the test runner
  });
});
