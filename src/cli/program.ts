import { Command } from "commander";

/**
 * Build the root `rex` command. Real resource/command wiring is added here as
 * the core layer and resources land; for now this proves the toolchain.
 *
 * Kept dependency-injectable (future: `buildProgram(deps)`) so command-level
 * tests can run the program against a fake transport without touching the
 * network.
 */
export function buildProgram(): Command {
  const program = new Command();

  program
    .name("rex")
    .description("Retail Express POS CLI for agentic workflows")
    .version("0.1.0");

  program
    .command("ping")
    .description("health check — confirms the binary runs")
    .action(() => {
      process.stdout.write(JSON.stringify({ ok: true, tool: "rex" }) + "\n");
    });

  return program;
}
