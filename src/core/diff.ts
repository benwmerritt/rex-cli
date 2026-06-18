import { PRICE_FIELDS, topLevelField } from "./fields";

export interface DiffResult {
  /** Minimal payload: only the keys whose value differs from current. */
  changed: Record<string, unknown>;
  changedKeys: string[];
  /** Subset of changedKeys that are price-gated. */
  touchedPriceFields: string[];
}

/**
 * Compute the minimal update payload. `desired` is a PARTIAL record (only the
 * fields a caller wants to set); `current` is the full fetched record. A key is
 * included only when its desired value differs from current.
 *
 * Because `desired` carries the COMPLETE intended value for any key it lists,
 * this naturally implements the safe rules from the design:
 *   - nested objects are sent whole (you supply the whole object)
 *   - arrays are replace-whole (you supply the whole array)
 * There is no positional array diffing.
 */
export function computeDiff(
  current: Record<string, unknown> | undefined,
  desired: Record<string, unknown>,
  priceFields: ReadonlySet<string> = PRICE_FIELDS,
): DiffResult {
  const changed: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(desired)) {
    if (!deepEqual(current?.[key], value)) {
      changed[key] = value;
    }
  }
  const changedKeys = Object.keys(changed);
  const touchedPriceFields = changedKeys.filter((k) => priceFields.has(topLevelField(k)));
  return { changed, changedKeys, touchedPriceFields };
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((x, i) => deepEqual(x, b[i]));
  }
  if (typeof a === "object" && typeof b === "object") {
    const ak = Object.keys(a as object);
    const bk = Object.keys(b as object);
    if (ak.length !== bk.length) return false;
    return ak.every((k) =>
      deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
    );
  }
  return false;
}
