import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { stateDir } from "./paths";

export interface AuditRecord {
  /** ISO timestamp — supplied by the caller (keeps this module clock-free/testable). */
  ts: string;
  profile: string;
  action: "create" | "update" | "disable" | "enable" | "stocktake_submit";
  resource: string;
  id?: string | number;
  changed?: string[];
  before?: unknown;
  after?: unknown;
  dryRun?: boolean;
}

/** Default audit log path (one JSONL file under the XDG state dir). */
export function auditPath(): string {
  return join(stateDir(), "audit.jsonl");
}

/**
 * Append one before→after record per write to a local JSONL audit log. Every
 * mutation rex performs is logged here for forensics and manual rollback.
 * Appends are atomic enough for line-oriented logging on a local filesystem.
 */
export function appendAudit(record: AuditRecord, path: string = auditPath()): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  appendFileSync(path, JSON.stringify(record) + "\n", { mode: 0o600 });
}
