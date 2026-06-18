import { describe, expect, it } from "bun:test";
import { Command } from "commander";
import { run, type PositionalArgs } from "../../src/cli/context";
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

  it("update accepts an id from --set when optional [id] is omitted", async () => {
    let seenUrl = "";
    const { out } = await runCli(
      ["product", "update", "--set", "id=5", "--set", "short_description=New", "--dry-run"],
      (method, url) => {
        if (method !== "GET") throw new Error(`unexpected ${method} in dry-run`);
        seenUrl = url;
        return { id: 5, short_description: "Old", brand: "Acme" };
      },
    );
    expect(seenUrl).toBe("https://x/v2.1/products/5");
    expect(JSON.parse(out)).toMatchObject({
      id: 5,
      action: "update",
      changed: ["short_description"],
      dryRun: true,
    });
  });

  it('update treats an omitted optional [id] as undefined, not "undefined"', async () => {
    let seenArgs: PositionalArgs | undefined;
    const out = capture();
    const err = capture();
    const program = new Command();
    program.exitOverride();
    program
      .command("product")
      .command("update [id]")
      .option("--set <kv...>")
      .option("--dry-run")
      .action(
        run({ env: { REX_API_KEY: "K" }, output: new Output({ mode: "json" }, out.writer, err.writer) }, (_ctx, _opts, args) => {
          seenArgs = args;
        }),
      );

    await program.parseAsync(["node", "rex", "product", "update", "--set", "short_description=New", "--dry-run"]);

    expect(seenArgs?.[0]).toBeUndefined();
    expect(seenArgs?.[0]).not.toBe("undefined");
  });

  it("update rejects missing ids when optional [id] is omitted and --set has no id", async () => {
    const prevExit = process.exitCode;
    let calls = 0;

    const { out, err } = await runCli(["product", "update", "--set", "short_description=New", "--dry-run"], () => {
      calls += 1;
      throw new Error("handler should not be called without an id");
    });

    expect(calls).toBe(0);
    expect(out).toBe("");
    expect(JSON.parse(err).error).toMatchObject({
      code: "validation",
      message: "Provide an <id>, --file, or --stdin.",
    });
    process.exitCode = prevExit;
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
