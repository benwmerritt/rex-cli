import { describe, expect, it } from "bun:test";
import { ValidationError } from "../src/core/errors";
import { adelaideDayMonth, resolvePeriod } from "../src/core/period";

const HOUR = 3_600_000;

describe("resolvePeriod --fy", () => {
  it("FY2026 spans 2025-07-01T00:00+09:30 to 2026-07-01T00:00+09:30 exclusive", () => {
    const p = resolvePeriod({ fy: 2026 });
    expect(p.fromIso).toBe("2025-06-30T14:30:00.000Z");
    expect(p.toIso).toBe("2026-06-30T14:30:00.000Z");
    expect(p.fromTs).toBe(Date.parse("2025-06-30T14:30:00Z"));
    expect(p.toTs).toBe(Date.parse("2026-06-30T14:30:00Z"));
    expect(p.label).toBe("FY2026");
  });

  it("rejects non-integer and out-of-range years", () => {
    expect(() => resolvePeriod({ fy: 2026.5 })).toThrow(ValidationError);
    expect(() => resolvePeriod({ fy: 26 })).toThrow(ValidationError);
  });
});

describe("resolvePeriod default (no selector)", () => {
  it("uses the current Australian FY relative to Adelaide-local now", () => {
    // 2026-06-30T13:00Z is still 30 June in Adelaide (22:30 +09:30) => FY2026.
    expect(resolvePeriod({}, new Date("2026-06-30T13:00:00Z")).label).toBe("FY2026");
    // Two hours later it is 1 July 00:30 Adelaide => FY2027.
    expect(resolvePeriod({}, new Date("2026-06-30T15:00:00Z")).label).toBe("FY2027");
  });
});

describe("resolvePeriod --from/--to", () => {
  it("treats --to as inclusive: range ends at the start of the next Adelaide day", () => {
    const p = resolvePeriod({ from: "2026-01-01", to: "2026-01-31" });
    // January is DST (+10:30): midnight Adelaide = 13:30Z the previous day.
    expect(p.fromIso).toBe("2025-12-31T13:30:00.000Z");
    expect(p.toIso).toBe("2026-01-31T13:30:00.000Z");
    expect(p.label).toBe("2026-01-01..2026-01-31");
  });

  it("spans the April fall-back: Apr 4-5 2026 inclusive is 49 hours", () => {
    // DST ends 2026-04-05 03:00 ACDT -> 02:00 ACST, so the 5th has 25 hours.
    const p = resolvePeriod({ from: "2026-04-04", to: "2026-04-05" });
    expect(p.fromIso).toBe("2026-04-03T13:30:00.000Z");
    expect(p.toIso).toBe("2026-04-05T14:30:00.000Z");
    expect(p.toTs - p.fromTs).toBe(49 * HOUR);
  });

  it("spans the October spring-forward: Oct 5 2025 alone is 23 hours", () => {
    const p = resolvePeriod({ from: "2025-10-05", to: "2025-10-05" });
    expect(p.fromIso).toBe("2025-10-04T14:30:00.000Z");
    expect(p.toIso).toBe("2025-10-05T13:30:00.000Z");
    expect(p.toTs - p.fromTs).toBe(23 * HOUR);
  });

  it("missing --to means now", () => {
    const now = new Date("2026-02-10T03:00:00Z");
    const p = resolvePeriod({ from: "2026-02-01" }, now);
    expect(p.toTs).toBe(now.getTime());
    expect(p.label).toBe("2026-02-01..now");
  });

  it("rejects --to without --from, malformed and impossible dates, and inverted ranges", () => {
    expect(() => resolvePeriod({ to: "2026-01-31" })).toThrow(ValidationError);
    expect(() => resolvePeriod({ from: "01-01-2026" })).toThrow(ValidationError);
    expect(() => resolvePeriod({ from: "2026-02-30", to: "2026-03-01" })).toThrow(ValidationError);
    expect(() => resolvePeriod({ from: "2026-03-01", to: "2026-02-01" })).toThrow(ValidationError);
  });
});

describe("resolvePeriod --last", () => {
  it("90d is exactly 90 days of ms back from now", () => {
    const now = new Date("2026-07-23T01:00:00Z");
    const p = resolvePeriod({ last: "90d" }, now);
    expect(p.toTs).toBe(now.getTime());
    expect(p.fromTs).toBe(now.getTime() - 90 * 24 * HOUR);
    expect(p.label).toBe("last 90d");
  });

  it("2w equals 14 days", () => {
    const now = new Date("2026-07-23T01:00:00Z");
    const p = resolvePeriod({ last: "2w" }, now);
    expect(p.fromTs).toBe(now.getTime() - 14 * 24 * HOUR);
  });

  it("1m from Adelaide Mar 31 clamps to Feb 28 (calendar-aware, wall time kept)", () => {
    // 2026-03-31T12:00 Adelaide (+10:30 DST) = 2026-03-31T01:30Z.
    const now = new Date("2026-03-31T01:30:00Z");
    const p = resolvePeriod({ last: "1m" }, now);
    // Feb is also DST: 2026-02-28T12:00+10:30 = 2026-02-28T01:30Z.
    expect(p.fromIso).toBe("2026-02-28T01:30:00.000Z");
    expect(p.label).toBe("last 1m");
  });

  it("6m crosses the October DST start with the wall time kept", () => {
    // 2026-01-15T10:00 Adelaide (+10:30) back 6 months => 2025-07-15T10:00 (+09:30).
    const p = resolvePeriod({ last: "6m" }, new Date("2026-01-14T23:30:00Z"));
    expect(p.fromIso).toBe("2025-07-15T00:30:00.000Z");
  });

  it("rejects malformed and zero-length specs", () => {
    for (const last of ["90x", "d", "0d", "-3d", "1.5m", ""]) {
      expect(() => resolvePeriod({ last })).toThrow(ValidationError);
    }
  });
});

describe("resolvePeriod selector conflicts", () => {
  it("allows only one of --fy, --last, --from/--to", () => {
    expect(() => resolvePeriod({ fy: 2026, from: "2026-01-01" })).toThrow(ValidationError);
    expect(() => resolvePeriod({ fy: 2026, last: "90d" })).toThrow(ValidationError);
    expect(() => resolvePeriod({ last: "90d", to: "2026-01-01" })).toThrow(ValidationError);
  });
});

describe("adelaideDayMonth", () => {
  it("buckets by the Adelaide calendar, not UTC", () => {
    // 13:29Z is 23:59 Adelaide (+10:30); one minute later rolls the local day.
    expect(adelaideDayMonth("2026-04-04T13:29:00Z")).toEqual({ day: "2026-04-04", month: "2026-04" });
    expect(adelaideDayMonth("2026-04-04T13:30:00Z")).toEqual({ day: "2026-04-05", month: "2026-04" });
  });

  it("handles both offsets of the fall-back morning of 2026-04-05", () => {
    // 02:30 ACDT (before the 03:00 -> 02:00 turn-back) and 02:30 ACST (after)
    // are different instants but the same Adelaide day.
    const before = adelaideDayMonth("2026-04-05T02:30:00+10:30");
    const after = adelaideDayMonth("2026-04-05T02:30:00+09:30");
    expect(before.day).toBe("2026-04-05");
    expect(after.day).toBe("2026-04-05");
    expect(Date.parse("2026-04-05T02:30:00+09:30") - Date.parse("2026-04-05T02:30:00+10:30")).toBe(HOUR);
  });

  it("rejects unparseable timestamps", () => {
    expect(() => adelaideDayMonth("not-a-date")).toThrow(ValidationError);
  });
});
