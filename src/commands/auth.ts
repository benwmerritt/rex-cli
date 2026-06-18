import type { Command } from "commander";
import { type ContextDeps, run } from "../cli/context";
import {
  DEFAULT_BASE_URL,
  DEFAULT_VERSION,
  loadConfig,
  saveProfile,
  setDefaultProfile,
} from "../core/config";
import { ValidationError } from "../core/errors";
import { configFile } from "../core/paths";

function redact(key: string | undefined): string {
  if (!key) return "";
  return key.length <= 6 ? "***" : `${key.slice(0, 4)}…${key.slice(-2)}`;
}

export function registerAuth(program: Command, deps: ContextDeps): void {
  const auth = program.command("auth").description("Credentials and tenant management");

  auth
    .command("login <name>")
    .description("Store an API key for a profile in config.toml (0600)")
    .option("--key <apiKey>", "API key (falls back to REX_API_KEY)")
    .option("--base-url <url>", "API base URL", DEFAULT_BASE_URL)
    .option("--api-version <v>", "data API version", DEFAULT_VERSION)
    .action(
      run(deps, (ctx, opts, args) => {
        const name = args[0]!;
        const key = (opts.key as string | undefined) ?? (deps.env ?? process.env).REX_API_KEY;
        if (!key) throw new ValidationError("Provide --key or set REX_API_KEY.");
        saveProfile({
          name,
          apiKey: key,
          baseUrl: opts.baseUrl as string,
          version: opts.apiVersion as string,
        });
        ctx.output.result({ ok: true, profile: name, config: configFile() });
      }),
    );

  auth
    .command("test")
    .description("Verify the active profile can authenticate and read")
    .action(
      run(deps, async (ctx) => {
        const profile = ctx.profile();
        // A cheap read exercises auth (token) + business access end to end.
        const res = await ctx.client().get<{ total_records?: number }>("outlets", {
          query: { page_size: 1 },
        });
        ctx.output.result({
          ok: true,
          profile: profile.name,
          baseUrl: profile.baseUrl,
          version: profile.version,
          outlets: res.total_records ?? null,
        });
      }),
    );

  auth
    .command("whoami")
    .description("Show the resolved active profile (no secrets)")
    .action(
      run(deps, (ctx) => {
        const p = ctx.profile();
        ctx.output.result({ profile: p.name, baseUrl: p.baseUrl, version: p.version });
      }),
    );

  auth
    .command("list")
    .description("List configured profiles")
    .action(
      run(deps, (ctx) => {
        const cfg = loadConfig();
        const nodes = Object.entries(cfg.profiles).map(([name, p]) => ({
          name,
          default: name === cfg.defaultProfile,
          base_url: p.base_url ?? DEFAULT_BASE_URL,
          version: p.version ?? DEFAULT_VERSION,
          api_key: redact(p.api_key),
          wms: Boolean(p.wms_client_id && p.wms_username && p.wms_password && p.wms_url),
          stocktake_user_id: p.stocktake_user_id ?? null,
        }));
        ctx.output.result({ nodes, pageInfo: { page: 1, pageSize: nodes.length, total: nodes.length } });
      }),
    );

  auth
    .command("default <name>")
    .description("Set the default profile")
    .action(
      run(deps, (ctx, _opts, args) => {
        setDefaultProfile(args[0]!);
        ctx.output.result({ ok: true, defaultProfile: args[0] });
      }),
    );
}
