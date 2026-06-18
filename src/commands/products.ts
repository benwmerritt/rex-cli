import { readFileSync } from "node:fs";
import type { Command } from "commander";
import { type ContextDeps, type RunContext, run } from "../cli/context";
import { appendAudit } from "../core/audit";
import type { QueryValue } from "../core/client";
import { ValidationError } from "../core/errors";
import { parseSet } from "../core/setflags";
import {
  createProduct,
  disableProduct,
  getProduct,
  listProducts,
  streamProducts,
  updateProduct,
  type WriteOptions,
  type WriteResult,
} from "../resources/products";

function buildQuery(opts: Record<string, unknown>): Record<string, QueryValue> {
  const query: Record<string, QueryValue> = {};
  if (opts.search) query.search = opts.search as string;
  for (const pair of (opts.filter as string[] | undefined) ?? []) {
    const idx = pair.indexOf("=");
    if (idx === -1) throw new ValidationError(`Invalid --filter "${pair}" (expected key=value).`);
    query[pair.slice(0, idx)] = pair.slice(idx + 1);
  }
  if (opts.includeInventory) query.include_inventory = true;
  return query;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function parseNdjson(text: string): Record<string, unknown>[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line, i) => {
      try {
        return JSON.parse(line) as Record<string, unknown>;
      } catch {
        throw new ValidationError(`Invalid NDJSON on line ${i + 1}.`);
      }
    });
}

async function gatherRecords(
  opts: Record<string, unknown>,
  args: string[],
  requireId: boolean,
): Promise<Record<string, unknown>[]> {
  if (opts.file) {
    const parsed = JSON.parse(readFileSync(opts.file as string, "utf8"));
    return Array.isArray(parsed) ? parsed : [parsed];
  }
  if (opts.stdin) return parseNdjson(await readStdin());

  const rec = parseSet((opts.set as string[] | undefined) ?? []);
  if (args[0] !== undefined) rec.id = args[0];
  if (opts.descriptionFile) rec.long_description = readFileSync(opts.descriptionFile as string, "utf8");
  if (requireId && rec.id === undefined) {
    throw new ValidationError("Provide an <id>, --file, or --stdin.");
  }
  if (Object.keys(rec).length === 0) {
    throw new ValidationError("Nothing to write (use --set, --file, or --stdin).");
  }
  return [rec];
}

function writeOptions(ctx: RunContext): WriteOptions {
  return {
    dryRun: ctx.dryRun,
    allowPrice: ctx.allowPrice,
    profile: ctx.profile().name,
    audit: (rec) => appendAudit(rec),
  };
}

function summarize(results: WriteResult[], total: number) {
  if (results.length === 1) return results[0];
  return {
    action: results[0]?.action ?? "update",
    total,
    applied: results.filter((r) => !r.dryRun && !r.skipped).length,
    skipped: results.filter((r) => r.skipped).length,
    dryRun: results[0]?.dryRun ?? false,
    results,
  };
}

export function registerProduct(program: Command, deps: ContextDeps): void {
  const product = program.command("product").alias("p").description("Manage products");

  product
    .command("list")
    .description("List products")
    .option("--search <q>", "full-text search across name/SKU/type/attributes")
    .option("--filter <kv...>", "filter_by key=value (repeatable)")
    .option("--include-inventory", "embed basic inventory in each product")
    .action(
      run(deps, async (ctx, opts) => {
        const query = buildQuery(opts);
        if (opts.all) {
          for await (const p of streamProducts(ctx.client(), { pageSize: opts.pageSize, query })) {
            ctx.output.line(p);
          }
          return;
        }
        ctx.output.result(
          await listProducts(ctx.client(), { page: opts.page, pageSize: opts.pageSize, query }),
        );
      }),
    );

  product
    .command("get <id>")
    .description("Get a product by id")
    .action(
      run(deps, async (ctx, _opts, args) => {
        ctx.output.result(await getProduct(ctx.client(), args[0]!));
      }),
    );

  product
    .command("search <query>")
    .description("Search products (shortcut for list --search)")
    .action(
      run(deps, async (ctx, opts, args) => {
        const query = { search: args[0]! };
        if (opts.all) {
          for await (const p of streamProducts(ctx.client(), { pageSize: opts.pageSize, query })) {
            ctx.output.line(p);
          }
          return;
        }
        ctx.output.result(
          await listProducts(ctx.client(), { page: opts.page, pageSize: opts.pageSize, query }),
        );
      }),
    );

  const writeFlags = (cmd: Command) =>
    cmd
      .option("--set <kv...>", "field assignment key=value (or key:=json)")
      .option("--file <path>", "JSON array/object of records to write")
      .option("--stdin", "read NDJSON records from stdin")
      .option("--description-file <path>", "read long_description from a file");

  writeFlags(
    product
      .command("update [id]")
      .description("Update product(s): re-fetch, diff, write only changed fields"),
  ).action(
    run(deps, async (ctx, opts, args) => {
      const records = await gatherRecords(opts, args, true);
      const wopts = writeOptions(ctx);
      const results: WriteResult[] = [];
      for (const rec of records) results.push(await updateProduct(ctx.client(), rec, wopts));
      ctx.output.result(summarize(results, records.length));
    }),
  );

  writeFlags(product.command("create").description("Create product(s)")).action(
    run(deps, async (ctx, opts, args) => {
      const records = await gatherRecords(opts, args, false);
      const wopts = writeOptions(ctx);
      const results: WriteResult[] = [];
      for (const rec of records) results.push(await createProduct(ctx.client(), rec, wopts));
      ctx.output.result(summarize(results, records.length));
    }),
  );

  product
    .command("disable <id>")
    .description("Soft-disable a product (hides from POS/reports/web — NOT a hard delete)")
    .action(
      run(deps, async (ctx, _opts, args) => {
        ctx.output.result(await disableProduct(ctx.client(), args[0]!, writeOptions(ctx)));
      }),
    );
}
