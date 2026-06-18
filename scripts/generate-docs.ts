/**
 * Generate skill/references/commands.md by introspecting the commander program,
 * so the command reference never drifts from the code. Run: `bun run docs`.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Command } from "commander";
import { buildProgram } from "../src/cli/program";

interface Arg {
  name(): string;
  required: boolean;
}

function usageArgs(cmd: Command): string {
  const args = ((cmd as unknown as { registeredArguments?: Arg[] }).registeredArguments ?? []).map(
    (a) => (a.required ? `<${a.name()}>` : `[${a.name()}]`),
  );
  return args.length ? ` ${args.join(" ")}` : "";
}

function walk(cmd: Command, prefix: string, out: string[]): void {
  const full = `${prefix} ${cmd.name()}`.trim();
  if (cmd.commands.length === 0) {
    out.push(`### \`${full}${usageArgs(cmd)}\``, "");
    if (cmd.description()) out.push(cmd.description(), "");
    const opts = cmd.options.filter((o) => !o.hidden);
    if (opts.length) {
      out.push("| Flag | Description |", "| --- | --- |");
      for (const o of opts) out.push(`| \`${o.flags}\` | ${o.description ?? ""} |`);
      out.push("");
    }
    return;
  }
  for (const sub of cmd.commands) walk(sub, full, out);
}

const program = buildProgram();
const lines: string[] = [
  "# rex command reference",
  "",
  "_Generated from the CLI definition — do not edit by hand (run `bun run docs`)._",
  "",
  "## Global options",
  "",
  "| Flag | Description |",
  "| --- | --- |",
  ...program.options.filter((o) => !o.hidden).map((o) => `| \`${o.flags}\` | ${o.description ?? ""} |`),
  "",
  "## Commands",
  "",
];

for (const cmd of program.commands) walk(cmd, "rex", lines);

const outPath = join(import.meta.dir, "..", "skill", "references", "commands.md");
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, lines.join("\n") + "\n");
console.log(`wrote ${outPath} (${program.commands.length} command groups)`);
