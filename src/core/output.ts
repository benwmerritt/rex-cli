import { toRexError } from "./errors";

export type OutputMode = "json" | "human";

export interface Writer {
  write(chunk: string): void;
}

export interface OutputConfig {
  mode: OutputMode;
  /** Pretty-print JSON results (2-space). Default true. NDJSON lines are always compact. */
  pretty?: boolean;
}

const stdoutWriter: Writer = { write: (s) => void process.stdout.write(s) };
const stderrWriter: Writer = { write: (s) => void process.stderr.write(s) };

/**
 * The single chokepoint for everything rex prints. Success → stdout; errors →
 * stderr as JSON with a stable exit code. Keeping this in one place means the
 * envelope shape and exit-code mapping never drift across commands.
 */
export class Output {
  private readonly mode: OutputMode;
  private readonly pretty: boolean;

  constructor(
    config: OutputConfig,
    private readonly out: Writer = stdoutWriter,
    private readonly err: Writer = stderrWriter,
  ) {
    this.mode = config.mode;
    this.pretty = config.pretty ?? true;
  }

  /** Render a single record or a `{ nodes, pageInfo }` list envelope to stdout. */
  result(data: unknown, human?: (data: unknown) => string): void {
    if (this.mode === "human") {
      this.out.write((human ? human(data) : toHuman(data)) + "\n");
    } else {
      this.out.write(this.json(data) + "\n");
    }
  }

  /** Stream one record as a line (NDJSON in json mode). Used by `--all`. */
  line(record: unknown): void {
    this.out.write((this.mode === "human" ? toHuman(record) : JSON.stringify(record)) + "\n");
  }

  /** Render an error to stderr (always JSON, even in --human). Returns the exit code. */
  error(err: unknown): number {
    const rexErr = toRexError(err);
    this.err.write(JSON.stringify(rexErr.toErrorPayload()) + "\n");
    return rexErr.exitCode;
  }

  private json(data: unknown): string {
    return this.pretty ? JSON.stringify(data, null, 2) : JSON.stringify(data);
  }
}

// ---- human rendering -------------------------------------------------------

function isScalar(v: unknown): boolean {
  return v === null || v === undefined || ["string", "number", "boolean"].includes(typeof v);
}

function cell(v: unknown): string {
  if (v === null || v === undefined) return "";
  return String(v);
}

const MAX_COLS = 8;
const MAX_CELL = 40;

function renderTable(rows: Array<Record<string, unknown>>): string {
  if (rows.length === 0) return "(no rows)";
  const cols: string[] = [];
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!cols.includes(key) && isScalar(row[key])) cols.push(key);
    }
  }
  const limited = cols.slice(0, MAX_COLS);
  const widths = limited.map((c) =>
    Math.max(c.length, ...rows.map((r) => cell(r[c]).slice(0, MAX_CELL).length)),
  );
  const fmt = (vals: string[]) => vals.map((v, i) => v.slice(0, MAX_CELL).padEnd(widths[i] ?? 0)).join("  ");
  const header = fmt(limited.map((c) => c.toUpperCase()));
  const body = rows.map((r) => fmt(limited.map((c) => cell(r[c])))).join("\n");
  return header + "\n" + body;
}

/** Best-effort human rendering: tables for lists, pretty JSON for nested objects. */
export function toHuman(data: unknown): string {
  if (data === null || data === undefined) return "";
  if (isScalar(data)) return String(data);
  if (Array.isArray(data)) {
    return data.every((d) => d && typeof d === "object" && !Array.isArray(d))
      ? renderTable(data as Array<Record<string, unknown>>)
      : JSON.stringify(data, null, 2);
  }
  const obj = data as Record<string, unknown>;
  if (Array.isArray(obj.nodes)) {
    const nodes = obj.nodes as Array<Record<string, unknown>>;
    const table = renderTable(nodes);
    const page = obj.pageInfo as Record<string, unknown> | undefined;
    const footer = page
      ? `\n\n(page ${cell(page.page) || "?"} · ${nodes.length} of ${cell(page.total) || "?"})`
      : "";
    return table + footer;
  }
  return JSON.stringify(obj, null, 2);
}
