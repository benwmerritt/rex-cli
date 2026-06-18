import { Command } from "commander";
import { registerApi } from "../commands/api";
import { registerAuth } from "../commands/auth";
import { registerConfig } from "../commands/config";
import { registerProduct } from "../commands/products";
import { registerResources } from "../commands/resources";
import { asInt, type ContextDeps } from "./context";

/**
 * Build the root `rex` command. `deps` is injectable so command-level tests can
 * run the program against a fake transport without touching the network.
 */
export function buildProgram(deps: ContextDeps = {}): Command {
  const program = new Command();

  program
    .name("rex")
    .description("Retail Express POS CLI for agentic workflows")
    .version("0.1.0")
    .option("--json", "JSON output (default)")
    .option("-H, --human", "human-readable tables")
    .option("-p, --profile <name>", "profile to use")
    .option("--dry-run", "compute changes without sending any write")
    .option("--allow-price", "permit writes to price fields")
    .option("--page <n>", "page number (1-based)", asInt)
    .option("--page-size <n>", "records per page (max 250)", asInt)
    .option("--all", "fetch every page (streams NDJSON)")
    .option("-v, --verbose", "verbose error output")
    .showHelpAfterError();

  registerAuth(program, deps);
  registerConfig(program, deps);
  registerApi(program, deps);
  registerProduct(program, deps);
  registerResources(program, deps);

  return program;
}
