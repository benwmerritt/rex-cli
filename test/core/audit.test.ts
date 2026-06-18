import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendAudit, type AuditRecord } from "../../src/core/audit";

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rex-audit-"));
  path = join(dir, "nested", "audit.jsonl");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const rec = (over: Partial<AuditRecord> = {}): AuditRecord => ({
  ts: "2026-06-18T00:00:00.000Z",
  profile: "show-go",
  action: "update",
  resource: "product",
  id: 4711,
  changed: ["short_description"],
  ...over,
});

describe("appendAudit", () => {
  it("creates the file (and dirs) and appends one JSON line per call", () => {
    appendAudit(rec(), path);
    appendAudit(rec({ id: 4712, action: "disable" }), path);
    const lines = readFileSync(path, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!).id).toBe(4711);
    expect(JSON.parse(lines[1]!)).toMatchObject({ id: 4712, action: "disable" });
  });

  it("writes the log 0600", () => {
    appendAudit(rec(), path);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});
