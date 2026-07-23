import { existsSync } from "node:fs";
import type { Command } from "commander";
import { asInt, asNonNegativeNumber, asPositiveInt, type ContextDeps, run } from "../cli/context";
import { StaleCacheError, ValidationError } from "../core/errors";
import { toHuman } from "../core/output";
import { resolvePeriod } from "../core/period";
import {
  type Dimension,
  DIMENSION_KEYS,
  getMeta,
  openSalesDb,
  runReport,
  salesDbFile,
  SORT_KEYS,
  type SortKey,
} from "../core/salesdb";
import { syncSales } from "../resources/sales";

const DIMENSIONS: ReadonlySet<string> = new Set(DIMENSION_KEYS);
const SORTS: ReadonlySet<string> = new Set(SORT_KEYS);

/** Comma-separated dimensions; deduped, order preserved. No --by = grand total. */
function parseBy(value: string | undefined): Dimension[] {
  if (value === undefined) return [];
  const dims = [...new Set(value.split(",").map((d) => d.trim()).filter((d) => d.length > 0))];
  if (dims.length === 0) throw new ValidationError("--by needs at least one dimension.");
  for (const dim of dims) {
    if (!DIMENSIONS.has(dim)) {
      throw new ValidationError(
        `Unknown --by dimension "${dim}" (use ${[...DIMENSIONS].join(", ")}).`,
      );
    }
  }
  return dims as Dimension[];
}

function parseSort(value: string | undefined): SortKey {
  if (value === undefined) return "revenue";
  if (!SORTS.has(value)) {
    throw new ValidationError(`Unknown --sort "${value}" (use ${[...SORTS].join(", ")}).`);
  }
  return value as SortKey;
}

export function registerSales(program: Command, deps: ContextDeps): void {
  const sales = program
    .command("sales")
    .description("Local sales cache: sync from Retail Express, report offline");

  sales
    .command("sync")
    .description("Mirror orders into the local sales cache (resumable; incremental after first run)")
    .option("--full", "re-stream every order instead of incremental catch-up")
    .action(
      run(deps, async (ctx, opts) => {
        const db = openSalesDb(salesDbFile(ctx.profile().name));
        try {
          const result = await syncSales(ctx.client(), db, {
            full: Boolean(opts.full),
            onProgress: (msg) => ctx.output.progress(msg),
          });
          ctx.output.result(result);
        } finally {
          db.close();
        }
      }),
    );

  sales
    .command("report")
    .description("Aggregate cached sales: revenue (headline), units, ex-GST gross profit")
    .option("--fy <year>", "Australian financial year (FY2026 = 2025-07-01..2026-07-01)", asInt)
    .option("--from <date>", "start date YYYY-MM-DD (Adelaide-local)")
    .option("--to <date>", "end date YYYY-MM-DD, inclusive (Adelaide-local)")
    .option("--last <window>", "trailing window: <n>d | <n>w | <n>m")
    .option("--by <dims>", "comma-separated: salesperson,outlet,product,month,day")
    .option("--sort <key>", "revenue | units | profit (default revenue, desc)")
    .option("--top <n>", "limit to the top n rows", asPositiveInt)
    .option("--product <id>", "restrict to one product's lines", asInt)
    .option(
      "--max-stale <hours>",
      "fail with exit 9 if the cache is older than this",
      asNonNegativeNumber,
    )
    .action(
      run(deps, (ctx, opts) => {
        const period = resolvePeriod({
          fy: opts.fy as number | undefined,
          from: opts.from as string | undefined,
          to: opts.to as string | undefined,
          last: opts.last as string | undefined,
        });
        const by = parseBy(opts.by as string | undefined);
        const sort = parseSort(opts.sort as string | undefined);

        const maxStaleHours = opts.maxStale as number | undefined;

        const dbPath = salesDbFile(ctx.profile().name);
        if (!existsSync(dbPath)) {
          throw new ValidationError("No sales cache for this profile. Run `rex sales sync` first.", {
            details: { path: dbPath },
          });
        }

        const db = openSalesDb(dbPath);
        try {
          // No last_synced_at ⇒ no sync ever completed: the cache is a partial
          // first stream and its totals would silently under-count.
          const syncedAt = getMeta(db, "last_synced_at");
          if (syncedAt === null) {
            throw new StaleCacheError(
              "Sales cache has never completed a sync (initial sync unfinished). Run `rex sales sync` to finish it.",
              { details: { path: dbPath, resume_page: getMeta(db, "full_sync_page") } },
            );
          }
          const syncedTs = Date.parse(syncedAt);
          if (!Number.isFinite(syncedTs)) {
            // Corrupt metadata must not slip past --max-stale as NaN.
            throw new StaleCacheError(
              "Sales cache metadata is corrupt (unparseable last_synced_at). Run `rex sales sync`.",
              { details: { path: dbPath, last_synced_at: syncedAt } },
            );
          }
          const ageMs = Math.max(0, Date.now() - syncedTs);
          // Rounded to 0.1h for display; the --max-stale gate uses the exact age.
          const staleHours = Math.round(ageMs / 360_000) / 10;

          if (maxStaleHours !== undefined && ageMs > maxStaleHours * 3_600_000) {
            throw new StaleCacheError(
              `Sales cache is ${staleHours}h stale (max ${maxStaleHours}h). Run \`rex sales sync\` first.`,
              { details: { synced_at: syncedAt, stale_hours: staleHours, max_stale: maxStaleHours } },
            );
          }

          const rows = runReport(db, {
            fromTs: period.fromTs,
            toTs: period.toTs,
            by,
            sort,
            top: opts.top as number | undefined,
            productId: opts.product as number | undefined,
          });

          ctx.output.result(
            {
              period: { from: period.fromIso, to: period.toIso, label: period.label },
              by,
              sort,
              rows,
              synced_at: syncedAt,
              stale_hours: staleHours,
            },
            () =>
              toHuman(rows) +
              `\n\n(${period.label} · synced ${syncedAt} · ${staleHours}h stale)`,
          );
        } finally {
          db.close();
        }
      }),
    );
}
