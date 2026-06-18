import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Minimal, dependency-free `.env` loader. Walks up from `startDir` to the
 * nearest `.env` and sets any keys that aren't already in the environment
 * (real env always wins). Lets a project drop a `.env` with REX_API_KEY and
 * have `rex` pick it up automatically — no `export` needed each session.
 */
export function loadDotenv(startDir: string = process.cwd(), env: NodeJS.ProcessEnv = process.env): void {
  const path = findDotenv(startDir);
  if (!path) return;
  for (const rawLine of readFileSync(path, "utf8").split("\n")) {
    const parsed = parseLine(rawLine);
    if (parsed && env[parsed.key] === undefined) env[parsed.key] = parsed.value;
  }
}

function findDotenv(startDir: string): string | undefined {
  let dir = startDir;
  for (;;) {
    const candidate = join(dir, ".env");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

export function parseLine(line: string): { key: string; value: string } | undefined {
  let text = line.trim();
  if (!text || text.startsWith("#")) return undefined;
  if (text.startsWith("export ")) text = text.slice("export ".length).trim();
  const eq = text.indexOf("=");
  if (eq <= 0) return undefined;
  const key = text.slice(0, eq).trim();
  let value = text.slice(eq + 1).trim();
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
  ) {
    value = value.slice(1, -1);
  }
  return { key, value };
}
