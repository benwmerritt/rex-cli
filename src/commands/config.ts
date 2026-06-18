import { existsSync } from "node:fs";
import type { Command } from "commander";
import { type ContextDeps, run } from "../cli/context";
import { loadConfig, saveWmsProfile, writeConfig } from "../core/config";
import { ValidationError } from "../core/errors";
import { configFile } from "../core/paths";

function redact(key: string | undefined): string {
  if (!key) return "";
  return key.length <= 6 ? "***" : `${key.slice(0, 4)}…${key.slice(-2)}`;
}

export function registerConfig(program: Command, deps: ContextDeps): void {
  const config = program.command("config").description("Configuration files");

  config
    .command("path")
    .description("Print the config file path")
    .action(
      run(deps, (ctx) => {
        ctx.output.result({ path: configFile() });
      }),
    );

  config
    .command("show")
    .description("Show the config with API keys redacted")
    .action(
      run(deps, (ctx) => {
        const cfg = loadConfig();
        const profiles = Object.fromEntries(
          Object.entries(cfg.profiles).map(([name, p]) => [
            name,
            {
              ...p,
              api_key: redact(p.api_key),
              wms_client_id: redact(p.wms_client_id),
              wms_password: redact(p.wms_password),
            },
          ]),
        );
        ctx.output.result({ path: configFile(), defaultProfile: cfg.defaultProfile, profiles });
      }),
    );

  config
    .command("init")
    .description("Create a starter config.toml if none exists")
    .action(
      run(deps, (ctx) => {
        const path = configFile();
        if (existsSync(path)) {
          ctx.output.result({ ok: true, created: false, path });
          return;
        }
        writeConfig({ profiles: {} }, path);
        ctx.output.result({
          ok: true,
          created: true,
          path,
          hint: "rex auth login <name> --key <apiKey>",
        });
      }),
    );

  config
    .command("wms <profile>")
    .description("Store WMS SOAP credentials for stocktake workflows")
    .option("--client-id <guid>", "Retail Express WMS client GUID (or REX_WMS_CLIENT_ID)")
    .option("--username <name>", "Retail Express WMS username (or REX_WMS_USERNAME)")
    .option("--password <password>", "Retail Express WMS password (or REX_WMS_PASSWORD)")
    .option("--url <url>", "Retail Express WMS service URL (or REX_WMS_URL)")
    .option("--stocktake-user-id <id>", "Retail Express user id for stocktake submissions")
    .action(
      run(deps, (ctx, opts, args) => {
        const env = deps.env ?? process.env;
        const clientId = optionOrEnv(opts.clientId, env.REX_WMS_CLIENT_ID);
        const username = optionOrEnv(opts.username, env.REX_WMS_USERNAME);
        const password = optionOrEnv(opts.password, env.REX_WMS_PASSWORD);
        const url = optionOrEnv(opts.url, env.REX_WMS_URL);
        const missing: string[] = [];
        if (!clientId) missing.push("--client-id or REX_WMS_CLIENT_ID");
        if (!username) missing.push("--username or REX_WMS_USERNAME");
        if (!password) missing.push("--password or REX_WMS_PASSWORD");
        if (!url) missing.push("--url or REX_WMS_URL");
        if (missing.length > 0) {
          throw new ValidationError("WMS SOAP credentials are required for `rex config wms`.", {
            details: {
              missing,
              hint: "Pass flags or export REX_WMS_CLIENT_ID, REX_WMS_USERNAME, REX_WMS_PASSWORD, and REX_WMS_URL.",
            },
          });
        }
        const stocktakeUserId =
          opts.stocktakeUserId === undefined ? undefined : parsePositiveInt(opts.stocktakeUserId as string);
        saveWmsProfile({
          name: args[0]!,
          clientId: clientId!,
          username: username!,
          password: password!,
          url: url!,
          stocktakeUserId,
        });
        ctx.output.result({ ok: true, profile: args[0], config: configFile(), wms: true });
      }),
    );
}

function optionOrEnv(option: unknown, envValue: string | undefined): string | undefined {
  const optionText = typeof option === "string" ? option.trim() : "";
  const envText = envValue?.trim() ?? "";
  return optionText || envText || undefined;
}

function parsePositiveInt(value: string): number {
  const text = value.trim();
  if (!/^\d+$/.test(text)) throw new ValidationError("--stocktake-user-id must be an integer.");
  const n = Number.parseInt(text, 10);
  if (n <= 0) throw new ValidationError("--stocktake-user-id must be a positive integer.");
  return n;
}
