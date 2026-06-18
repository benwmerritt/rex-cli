import type { Command } from "commander";
import { type ContextDeps, run } from "../cli/context";
import { appendAudit } from "../core/audit";
import { resolveStocktakeUserId } from "../core/config";
import { ApiError, EXIT, RexError, ValidationError } from "../core/errors";
import { parsePositiveInt } from "../core/validation";
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
  sessionStorageKey,
  summarizeSession,
  upsertLine,
  type ResolvedProduct,
  type StocktakeSession,
} from "../resources/stocktake";

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
        const storageKey = sessionStorageKey(profile);
        if (maybeLoadSession(storageKey) && !opts.force) {
          throw new ValidationError("A stocktake session is already active.", {
            details: { hint: "Run `rex stocktake review`, `rex stocktake submit`, or `rex stocktake abort`." },
          });
        }
        const explicitUserId = opts.userId === undefined ? undefined : parsePositiveInt(opts.userId, "--user-id");
        const userId = explicitUserId ?? resolveStocktakeUserId(profile);
        if (!userId) {
          throw new ValidationError("Stocktake user id is required.", {
            details: { hint: "Use --user-id or configure stocktake_user_id with `rex config wms`." },
          });
        }
        const outlet = await resolveOutlet(ctx.client(), opts.outlet as string);
        const session = createSession({ profile: profile.name, outlet, userId });
        saveSession(session, storageKey);
        ctx.output.result({ ok: true, session: summarizeSession(session) });
      }),
    );

  stocktake
    .command("count <query...>")
    .description("Stage an absolute counted quantity for a product")
    .action(
      run(deps, async (ctx, _opts, args) => {
        const profile = ctx.profile();
        const storageKey = sessionStorageKey(profile);
        const session = loadSession(storageKey);
        const { query, counted } = parseCountArgs(args.filter((arg): arg is string => arg !== undefined));
        const product = await resolveProduct(ctx.client(), query);
        const inventory = await fetchOutletInventory(ctx.client(), product.id, session.outletId);
        const result = upsertAndSave(session, {
          storageKey,
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
        const profile = ctx.profile();
        ctx.output.result(summarizeSession(loadSession(sessionStorageKey(profile))));
      }),
    );

  stocktake
    .command("remove <line-id>")
    .description("Remove a staged stocktake line by line id or product id")
    .action(
      run(deps, (ctx, _opts, args) => {
        const lineId = args[0];
        if (!lineId) throw new ValidationError("Stocktake line id is required.");
        const profile = ctx.profile();
        const storageKey = sessionStorageKey(profile);
        const session = loadSession(storageKey);
        const result = removeLine(session, lineId);
        saveSession(result.session, storageKey);
        ctx.output.result({ ok: true, removed: result.line, summary: summarizeSession(result.session) });
      }),
    );

  stocktake
    .command("submit")
    .description("Submit the active session to WMS CreateStocktake")
    .action(
      run(deps, async (ctx) => {
        const profile = ctx.profile();
        const storageKey = sessionStorageKey(profile);
        const session = loadSession(storageKey);
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
          clearSession(storageKey);
          ctx.output.result({
            ok: true,
            submitted: false,
            reason: "no_variance",
            cleared: true,
            sessionId: session.id,
          });
          return;
        }

        let result: unknown;
        try {
          result = await ctx.wmsClient().createStocktake(payload);
        } catch (err) {
          throw submitFailureError(err);
        }
        const clearResult = clearSubmittedSession(storageKey);
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
            warning: clearResult.cleared
              ? "Stocktake was submitted and the session was cleared, but audit logging failed."
              : "Stocktake was submitted, but the session could not be cleared and audit logging failed.",
            error: errorMessage(err),
          };
        }
        ctx.output.result({
          ok: true,
          submitted: true,
          cleared: clearResult.cleared,
          sessionId: session.id,
          submitLines: submitLines.length,
          skippedZeroVariance: session.lines.length - submitLines.length,
          result,
          ...(clearResult.warning ? { clear: clearResult.warning } : {}),
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
        const storageKey = sessionStorageKey(profile);
        const existed = Boolean(maybeLoadSession(storageKey));
        clearSession(storageKey);
        ctx.output.result({ ok: true, aborted: existed });
      }),
    );
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

interface WarningInfo {
  warning: string;
  error: string;
  hint?: string;
}

function clearSubmittedSession(storageKey: string): { cleared: boolean; warning?: WarningInfo } {
  try {
    clearSession(storageKey);
    return { cleared: true };
  } catch (err) {
    return {
      cleared: false,
      warning: {
        warning: "Stocktake was submitted, but the local session could not be cleared.",
        error: errorMessage(err),
        hint: "Resolve the local session file issue before submitting again to avoid duplicate stocktakes.",
      },
    };
  }
}

type SubmitFailureKind = "ambiguous" | "retryable";

function submitFailureError(err: unknown): RexError {
  const kind = classifySubmitFailure(err);
  const suffix =
    kind === "ambiguous"
      ? "Local stocktake session was kept, but WMS may have processed the request."
      : "Local stocktake session was kept for retry.";
  if (err instanceof ApiError) {
    return new ApiError(`${err.message} ${suffix}`, err.status, {
      cause: err,
      details: submitFailureDetails(err, kind),
    });
  }
  if (err instanceof RexError) {
    return new RexError(err.code, `${err.message} ${suffix}`, err.exitCode, {
      cause: err,
      details: submitFailureDetails(err, kind),
    });
  }
  return new RexError("generic", `${errorMessage(err)} ${suffix}`, EXIT.GENERIC, {
    cause: err,
    details: submitFailureDetails(err, kind),
  });
}

function classifySubmitFailure(err: unknown): SubmitFailureKind {
  if (err instanceof ApiError && (err.status === 0 || err.status >= 500)) return "ambiguous";
  return hasAmbiguousNetworkSignal(err) ? "ambiguous" : "retryable";
}

function submitFailureDetails(err: unknown, kind: SubmitFailureKind): Record<string, unknown> {
  const stocktakeSession =
    kind === "ambiguous"
      ? {
          preserved: true,
          warning: "WMS may have processed this stocktake before the failure was reported.",
          hint: "Check WMS for an awaiting-authorisation stocktake before retrying to avoid duplicate stocktakes.",
        }
      : {
          preserved: true,
          hint: "The local stocktake session was not cleared. Resolve the WMS issue and retry `rex stocktake submit`, or run `rex stocktake abort` to discard it.",
        };
  if (!(err instanceof RexError) || err.details === undefined) return { stocktakeSession };
  if (isRecord(err.details)) return { ...err.details, stocktakeSession };
  return { originalDetails: err.details, stocktakeSession };
}

function hasAmbiguousNetworkSignal(value: unknown, depth = 0): boolean {
  if (depth > 4 || !isRecord(value)) return false;
  const code = typeof value.code === "string" ? value.code.toUpperCase() : undefined;
  if (code && ["ETIMEDOUT", "ECONNRESET", "ECONNABORTED", "EPIPE"].includes(code)) return true;
  const name = typeof value.name === "string" ? value.name : "";
  const message = typeof value.message === "string" ? value.message : "";
  if (/(abort|timeout|timed out|connection reset|econnreset|etimedout)/i.test(`${name} ${message}`)) {
    return true;
  }
  return hasAmbiguousNetworkSignal(value.cause, depth + 1);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function upsertAndSave(
  session: StocktakeSession,
  input: {
    storageKey: string;
    query: string;
    product: ResolvedProduct;
    counted: number;
    currentStock: number;
  },
): ReturnType<typeof upsertLine> {
  const result = upsertLine(session, input);
  saveSession(result.session, input.storageKey);
  return result;
}
