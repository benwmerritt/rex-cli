import { existsSync } from "node:fs";
import type { Command } from "commander";
import { type ContextDeps, run } from "../cli/context";
import { loadConfig, writeConfig } from "../core/config";
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
          Object.entries(cfg.profiles).map(([name, p]) => [name, { ...p, api_key: redact(p.api_key) }]),
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
}
