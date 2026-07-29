import type { Command } from "commander";
import { type ContextDeps, run } from "../cli/context";
import { capabilityReport } from "../core/capabilities";

export function registerDoctor(program: Command, deps: ContextDeps): void {
  program
    .command("doctor")
    .description("Report which credentials are configured and which workflows they unlock")
    .action(
      run(deps, (ctx) => {
        ctx.output.result(capabilityReport(ctx.profile()));
      }),
    );
}
