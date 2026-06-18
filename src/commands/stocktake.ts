import type { Command } from "commander";
import { type ContextDeps, run } from "../cli/context";
import { appendAudit } from "../core/audit";
import { resolveStocktakeUserId } from "../core/config";
import { ValidationError } from "../core/errors";
import {
  clearSession,
  createSession,
  fetchOutletInventory,
  loadSession,
  maybeLoadSession,
  parseCountArgs,
  removeLine,
  resolveOutlet,
  resolveProduct,
  saveSession,
  summarizeSession,
  upsertLine,
  type ResolvedProduct,
  type StocktakeSession,
} from "../resources/stocktake";

function intOption(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined;
  const text = String(value).trim();
  if (!/^\d+$/.test(text)) throw new ValidationError(`${name} must be a positive integer.`);
  const n = Number.parseInt(text, 10);
  if (!Number.isInteger(n) || n <= 0) throw new ValidationError(`${name} must be a positive integer.`);
  return n;
}

export function registerStocktake(program: Command, deps: ContextDeps): void {
  const stocktake = program.command("stocktake").alias("st").description("Agent-friendly stocktake counts");

  stocktake
    .command("begin")
    .description("Start a local stocktake session for one outlet")
    .requiredOption("--outlet <id-or-name>", "Retail Express outlet id or name for this stocktake")
    .option("--user-id <id>", "Retail Express user id for WMS stocktake submission")
    .option("--force", "replace an existing active stocktake session")
    .action(
      run(deps, async (ctx, opts) => {
        const profile = ctx.profile();
        if (maybeLoadSession(profile.name) && !opts.force) {
          throw new ValidationError("A stocktake session is already active.", {
            details: { hint: "Run `rex stocktake review`, `rex stocktake submit`, or `rex stocktake abort`." },
          });
        }
        const explicitUserId = intOption(opts.userId, "--user-id");
        const userId = explicitUserId ?? resolveStocktakeUserId(profile);
        if (!userId) {
          throw new ValidationError("Stocktake user id is required.", {
            details: { hint: "Use --user-id or configure stocktake_user_id with `rex config wms`." },
          });
        }
        const outlet = await resolveOutlet(ctx.client(), opts.outlet as string);
        const session = createSession({ profile: profile.name, outlet, userId });
        saveSession(session);
        ctx.output.result({ ok: true, session: summarizeSession(session) });
      }),
    );

  stocktake
    .command("count <query...>")
    .description("Stage an absolute counted quantity for a product")
    .action(
      run(deps, async (ctx, _opts, args) => {
        const profile = ctx.profile();
        const session = loadSession(profile.name);
        const { query, counted } = parseCountArgs(args.filter((arg): arg is string => arg !== undefined));
        const product = await resolveProduct(ctx.client(), query);
        const inventory = await fetchOutletInventory(ctx.client(), product.id, session.outletId);
        const result = upsertAndSave(session, {
          query,
          product,
          counted,
          currentStock: inventory.currentStock,
        });
        ctx.output.result({
          ok: true,
          updated: result.updated,
          line: result.line,
          summary: summarizeSession(result.session),
        });
      }),
    );

  stocktake
    .command("review")
    .alias("status")
    .description("Review the active stocktake session")
    .action(
      run(deps, (ctx) => {
        ctx.output.result(summarizeSession(loadSession(ctx.profile().name)));
      }),
    );

  stocktake
    .command("remove <line-id>")
    .description("Remove a staged stocktake line by line id or product id")
    .action(
      run(deps, (ctx, _opts, args) => {
        const lineId = args[0];
        if (!lineId) throw new ValidationError("Stocktake line id is required.");
        const session = loadSession(ctx.profile().name);
        const result = removeLine(session, lineId);
        saveSession(result.session);
        ctx.output.result({ ok: true, removed: result.line, summary: summarizeSession(result.session) });
      }),
    );

  stocktake
    .command("submit")
    .description("Submit the active session to WMS CreateStocktake")
    .action(
      run(deps, async (ctx) => {
        const profile = ctx.profile();
        const session = loadSession(profile.name);
        const submitLines = session.lines.filter((line) => line.variance !== 0);
        const payload = {
          outletId: session.outletId,
          userId: session.userId,
          items: submitLines.map((line) => ({ productId: line.productId, variance: line.variance })),
        };

        if (ctx.dryRun) {
          ctx.output.result({
            ok: true,
            dryRun: true,
            action: "stocktake_submit",
            submitLines: submitLines.length,
            skippedZeroVariance: session.lines.length - submitLines.length,
            payload,
            session: summarizeSession(session),
          });
          return;
        }

        if (submitLines.length === 0) {
          clearSession(profile.name);
          ctx.output.result({
            ok: true,
            submitted: false,
            reason: "no_variance",
            cleared: true,
            sessionId: session.id,
          });
          return;
        }

        const result = await ctx.wmsClient().createStocktake(payload);
        clearSession(profile.name);
        let auditWarning: { warning: string; error: string } | undefined;
        try {
          appendAudit({
            ts: new Date().toISOString(),
            profile: profile.name,
            action: "stocktake_submit",
            resource: "stocktake",
            id: session.id,
            changed: submitLines.map((line) => String(line.productId)),
            before: session.lines.map((line) => ({
              productId: line.productId,
              counted: line.counted,
              currentStock: line.currentStock,
            })),
            after: payload,
          });
        } catch (err) {
          auditWarning = {
            warning: "Stocktake was submitted and the session was cleared, but audit logging failed.",
            error: errorMessage(err),
          };
        }
        ctx.output.result({
          ok: true,
          submitted: true,
          cleared: true,
          sessionId: session.id,
          submitLines: submitLines.length,
          skippedZeroVariance: session.lines.length - submitLines.length,
          result,
          ...(auditWarning ? { audit: auditWarning } : {}),
        });
      }),
    );

  stocktake
    .command("abort")
    .description("Discard the active local stocktake session")
    .action(
      run(deps, (ctx) => {
        const profile = ctx.profile();
        const existed = Boolean(maybeLoadSession(profile.name));
        clearSession(profile.name);
        ctx.output.result({ ok: true, aborted: existed });
      }),
    );
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function upsertAndSave(
  session: StocktakeSession,
  input: {
    query: string;
    product: ResolvedProduct;
    counted: number;
    currentStock: number;
  },
): ReturnType<typeof upsertLine> {
  const result = upsertLine(session, input);
  saveSession(result.session);
  return result;
}
