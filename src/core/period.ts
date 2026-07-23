import { ValidationError } from "./errors";

/**
 * Reporting periods. All boundaries are Adelaide-local instants: the store
 * trades in Australia/Adelaide (+9:30, +10:30 during DST), so calendar dates,
 * financial years, and day buckets follow that clock — never UTC.
 */

const TIME_ZONE = "Australia/Adelaide";

/** Mutually exclusive period selectors as they arrive from commander. */
export interface PeriodFlags {
  fy?: number;
  from?: string;
  to?: string;
  last?: string;
}

/** Half-open instant range `[from, to)`; `*Ts` are unix ms. */
export interface Period {
  fromIso: string;
  toIso: string;
  fromTs: number;
  toTs: number;
  label: string;
}

/** Shared formatter (construction is expensive); h23 keeps midnight as "00". */
const wallFormat = new Intl.DateTimeFormat("en-AU", {
  timeZone: TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

interface Wall {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/** Adelaide wall-clock fields for an instant. */
function toWall(ts: number): Wall {
  const parts: Partial<Record<Intl.DateTimeFormatPartTypes, string>> = {};
  for (const p of wallFormat.formatToParts(new Date(ts))) parts[p.type] = p.value;
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

/** Adelaide UTC offset at `ts` in ms (34200000 standard, 37800000 DST). */
function offsetAt(ts: number): number {
  const w = toWall(ts);
  const wallAsUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  return wallAsUtc - Math.floor(ts / 1000) * 1000;
}

/**
 * Instant for an Adelaide wall-clock time. Two offset probes converge across
 * DST transitions; Adelaide switches at 2/3am, so the midnights and FY
 * boundaries we resolve here are never skipped or ambiguous.
 */
function fromWall(year: number, month: number, day: number, hour = 0, minute = 0, second = 0): number {
  const wallAsUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  const guess = wallAsUtc - offsetAt(wallAsUtc);
  return wallAsUtc - offsetAt(guess);
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

const pad = (n: number): string => String(n).padStart(2, "0");

/** Adelaide-local 'YYYY-MM-DD' / 'YYYY-MM' buckets for an ISO timestamp (any offset). */
export function adelaideDayMonth(iso: string): { day: string; month: string } {
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) throw new ValidationError(`unparseable timestamp "${iso}"`);
  const w = toWall(ts);
  const month = `${w.year}-${pad(w.month)}`;
  return { day: `${month}-${pad(w.day)}`, month };
}

/** Strict 'YYYY-MM-DD'; rejects impossible calendar dates (e.g. 2026-02-30). */
function parseLocalDate(value: string, flag: string): { year: number; month: number; day: number } {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) throw new ValidationError(`--${flag} must be YYYY-MM-DD, got "${value}"`);
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  // Date.UTC maps years 0-99 to 1900-1999, so "0050-01-01" would silently
  // become 1950 — refuse the whole two-digit-year hazard zone.
  if (year < 100) throw new ValidationError(`--${flag} year is out of range: "${value}"`);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
    throw new ValidationError(`--${flag} is not a real date: "${value}"`);
  }
  return { year, month, day };
}

function build(fromTs: number, toTs: number, label: string): Period {
  return {
    fromIso: new Date(fromTs).toISOString(),
    toIso: new Date(toTs).toISOString(),
    fromTs,
    toTs,
    label,
  };
}

/** Australian FY: FY2026 = 2025-07-01T00:00 Adelaide through 2026-07-01 (exclusive). */
function fyPeriod(fy: number): Period {
  if (!Number.isInteger(fy) || fy < 1971 || fy > 9999) {
    throw new ValidationError(`--fy must be a 4-digit year, got "${fy}"`);
  }
  return build(fromWall(fy - 1, 7, 1), fromWall(fy, 7, 1), `FY${fy}`);
}

/** FY the Adelaide-local `now` falls in (July onward belongs to the next FY). */
function currentFy(now: Date): number {
  const w = toWall(now.getTime());
  return w.month >= 7 ? w.year + 1 : w.year;
}

function rangePeriod(from: string | undefined, to: string | undefined, now: Date): Period {
  if (from === undefined) throw new ValidationError("--to requires --from");
  const f = parseLocalDate(from, "from");
  const fromTs = fromWall(f.year, f.month, f.day);
  let toTs: number;
  let label: string;
  if (to === undefined) {
    toTs = now.getTime();
    label = `${from}..now`;
  } else {
    const t = parseLocalDate(to, "to");
    // --to is inclusive as a date: end at the start of the following Adelaide day.
    toTs = fromWall(t.year, t.month, t.day + 1);
    label = `${from}..${to}`;
  }
  if (fromTs >= toTs) throw new ValidationError(`--from must be before --to (got ${label})`);
  return build(fromTs, toTs, label);
}

function lastPeriod(spec: string, now: Date): Period {
  const m = /^([1-9]\d*)([dwm])$/.exec(spec);
  if (!m) throw new ValidationError(`--last must be <n>d, <n>w, or <n>m, got "${spec}"`);
  const n = Number(m[1]);
  // Beyond this the wall-clock math leaves Date/Intl's representable range
  // and produces NaN instants; nothing real is that far back anyway.
  if (n > 12_000) throw new ValidationError(`--last window too large: "${spec}"`);
  const toTs = now.getTime();
  let fromTs: number;
  if (m[2] === "m") {
    // Calendar-aware: same Adelaide wall-clock time n months back, day clamped
    // to the target month's length (Mar 31 - 1m => Feb 28/29). Wall fields
    // carry whole seconds only, so restore the millisecond remainder.
    const w = toWall(toTs);
    const total = w.year * 12 + (w.month - 1) - n;
    const year = Math.floor(total / 12);
    const month = (total % 12) + 1;
    const day = Math.min(w.day, daysInMonth(year, month));
    fromTs = fromWall(year, month, day, w.hour, w.minute, w.second) + (toTs % 1000);
  } else {
    fromTs = toTs - (m[2] === "w" ? n * 7 : n) * 86_400_000;
  }
  return build(fromTs, toTs, `last ${spec}`);
}

/**
 * Resolve --fy | --last | --from/--to into a concrete instant range. Exactly
 * one selector is allowed; none defaults to the current Australian FY at `now`.
 * `to` is inclusive as an Adelaide date; a missing `to` means `now`.
 */
export function resolvePeriod(flags: PeriodFlags, now: Date = new Date()): Period {
  const picked = [
    flags.fy !== undefined,
    flags.last !== undefined,
    flags.from !== undefined || flags.to !== undefined,
  ].filter(Boolean).length;
  if (picked > 1) throw new ValidationError("use only one of --fy, --last, or --from/--to");
  if (flags.last !== undefined) return lastPeriod(flags.last, now);
  if (flags.from !== undefined || flags.to !== undefined) return rangePeriod(flags.from, flags.to, now);
  return fyPeriod(flags.fy ?? currentFy(now));
}
