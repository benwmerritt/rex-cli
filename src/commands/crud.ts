import { readFileSync } from "node:fs";
import type { Command } from "commander";
import { type ContextDeps, type RunContext, run } from "../cli/context";
import { appendAudit } from "../core/audit";
import type { QueryValue } from "../core/client";
import { ValidationError } from "../core/errors";
import { parseSet } from "../core/setflags";
import {
  createResource,
  disableResource,
  getResource,
  listResource,
  type ResourceConfig,
  streamResource,
  updateResource,
  type WriteOptions,
  type WriteResult,
} from "../resources/crud";

/** Declarative description of a resource's CLI surface. */
export interface CrudSpec {
  /** Command name (e.g. "product"). */
  name: string;
  alias?: string;
  /** API path segment (e.g. "products"). */
  path: string;
  /** Singular name for audit/errors; defaults to `name`. */
  resource?: string;
  description: string;
  /** Wire a `get <id>` command. Default true. */
  getById?: boolean;
  /** Wire `search` + `--search` on list. */
  searchable?: boolean;
  /** Individual write verbs (default false). */
  create?: boolean;
  update?: boolean;
  disable?: boolean;
  priceFields?: ReadonlySet<string>;
  /** Add resource-specific list flags. */
  listOptions?: (cmd: Command) => Command;
}

function config(spec: CrudSpec): ResourceConfig {
  return { resource: spec.resource ?? spec.name, path: spec.path, priceFields: spec.priceFields };
}

function buildQuery(opts: Record<string, unknown>): Record<string, QueryValue> {
  const query: Record<string, QueryValue> = {};
  if (opts.search) query.search = opts.search as string;
  if (opts.includeInventory) query.include_inventory = true;
  if (opts.modifiedSince) query.modified_since = opts.modifiedSince as string;
  if (opts.updatedSince) query.updated_since = opts.updatedSince as string;
  for (const name of (opts.include as string[] | undefined) ?? []) {
    query[`include_${name}`] = true;
  }
  for (const pair of (opts.filter as string[] | undefined) ?? []) {
    const idx = pair.indexOf("=");
    if (idx === -1) throw new ValidationError(`Invalid --filter "${pair}" (expected key=value).`);
    query[pair.slice(0, idx)] = pair.slice(idx + 1);
  }
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
  if (requireId && rec.id === undefined) throw new ValidationError("Provide an <id>, --file, or --stdin.");
  if (Object.keys(rec).length === 0) throw new ValidationError("Nothing to write (use --set, --file, or --stdin).");
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

function summarize(results: WriteResult[], total: number): WriteResult | Record<string, unknown> {
  if (results.length === 1) return results[0]!;
  return {
    action: results[0]?.action ?? "update",
    total,
    applied: results.filter((r) => !r.dryRun && !r.skipped).length,
    skipped: results.filter((r) => r.skipped).length,
    dryRun: results[0]?.dryRun ?? false,
    results,
  };
}

/** Register the standard list/get/[search]/[create/update/disable] commands for a resource. */
export function registerCrud(program: Command, deps: ContextDeps, spec: CrudSpec): Command {
  const cfg = config(spec);
  const group = program.command(spec.name).description(spec.description);
  if (spec.alias) group.alias(spec.alias);

  const list = group.command("list").description(`List ${spec.path}`);
  if (spec.searchable) list.option("--search <q>", "full-text search");
  list.option("--filter <kv...>", "filter_by key=value (repeatable)");
  (spec.listOptions ?? ((c) => c))(list).action(
    run(deps, async (ctx, opts) => {
      const query = buildQuery(opts);
      if (opts.all) {
        for await (const row of streamResource(ctx.client(), spec.path, { pageSize: opts.pageSize, query })) {
          ctx.output.line(row);
        }
        return;
      }
      ctx.output.result(
        await listResource(ctx.client(), spec.path, { page: opts.page, pageSize: opts.pageSize, query }),
      );
    }),
  );

  if (spec.getById !== false) {
    group
      .command("get <id>")
      .description(`Get a ${spec.resource ?? spec.name} by id`)
      .action(
        run(deps, async (ctx, _opts, args) => {
          ctx.output.result(await getResource(ctx.client(), spec.path, args[0]!));
        }),
      );
  }

  if (spec.searchable) {
    group
      .command("search <query>")
      .description(`Search ${spec.path} (shortcut for list --search)`)
      .action(
        run(deps, async (ctx, opts, args) => {
          const query = { search: args[0]! };
          if (opts.all) {
            for await (const row of streamResource(ctx.client(), spec.path, { pageSize: opts.pageSize, query })) {
              ctx.output.line(row);
            }
            return;
          }
          ctx.output.result(
            await listResource(ctx.client(), spec.path, { page: opts.page, pageSize: opts.pageSize, query }),
          );
        }),
      );
  }

  const writeFlags = (cmd: Command) =>
    cmd
      .option("--set <kv...>", "field assignment key=value (or key:=json)")
      .option("--file <path>", "JSON array/object of records to write")
      .option("--stdin", "read NDJSON records from stdin")
      .option("--description-file <path>", "read long_description from a file");

  if (spec.update) {
    writeFlags(
      group
        .command("update [id]")
        .description(`Update ${spec.path}: re-fetch, diff, write only changed fields`),
    ).action(
      run(deps, async (ctx, opts, args) => {
        const records = await gatherRecords(opts, args, true);
        const wopts = writeOptions(ctx);
        const results: WriteResult[] = [];
        for (const rec of records) results.push(await updateResource(ctx.client(), cfg, rec, wopts));
        ctx.output.result(summarize(results, records.length));
      }),
    );
  }

  if (spec.create) {
    writeFlags(group.command("create").description(`Create ${spec.path}`)).action(
      run(deps, async (ctx, opts, args) => {
        const records = await gatherRecords(opts, args, false);
        const wopts = writeOptions(ctx);
        const results: WriteResult[] = [];
        for (const rec of records) results.push(await createResource(ctx.client(), cfg, rec, wopts));
        ctx.output.result(summarize(results, records.length));
      }),
    );
  }

  if (spec.disable) {
    group
      .command("disable <id>")
      .description(`Soft-disable a ${spec.resource ?? spec.name} (not a hard delete)`)
      .action(
        run(deps, async (ctx, _opts, args) => {
          ctx.output.result(await disableResource(ctx.client(), cfg, args[0]!, writeOptions(ctx)));
        }),
      );
  }

  return group;
}
