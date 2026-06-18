import { readFileSync } from "node:fs";
import type { Command } from "commander";
import { type ContextDeps, run } from "../cli/context";
import type { QueryValue } from "../core/client";
import { ValidationError } from "../core/errors";

function parseQueryPairs(pairs: string[] | undefined): Record<string, QueryValue> {
  const query: Record<string, QueryValue> = {};
  for (const pair of pairs ?? []) {
    const idx = pair.indexOf("=");
    if (idx === -1) throw new ValidationError(`Invalid --query "${pair}" (expected key=value).`);
    query[pair.slice(0, idx)] = pair.slice(idx + 1);
  }
  return query;
}

export function registerApi(program: Command, deps: ContextDeps): void {
  program
    .command("api <method> <path>")
    .description("Raw passthrough to the Retail Express API (escape hatch for un-wrapped endpoints)")
    .option("--data <json>", "JSON request body")
    .option("--data-file <file>", "read the JSON body from a file")
    .option("-q, --query <kv...>", "query params, key=value (repeatable)")
    .action(
      run(deps, async (ctx, opts, args) => {
        const method = args[0]!.toUpperCase();
        const path = args[1]!;
        const query = parseQueryPairs(opts.query as string[] | undefined);

        let body: unknown;
        if (opts.dataFile) {
          body = JSON.parse(readFileSync(opts.dataFile as string, "utf8"));
        } else if (opts.data) {
          try {
            body = JSON.parse(opts.data as string);
          } catch {
            throw new ValidationError("Invalid JSON in --data.");
          }
        }

        const res = await ctx.client().request(method, path, { query, body });
        ctx.output.result(res);
      }),
    );
}
