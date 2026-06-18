import { ValidationError } from "./errors";
import { NUMERIC_FIELDS } from "./fields";

/**
 * Parse `--set` assignments into a partial object.
 *
 * Forms:
 *   key=value        value coerced: true/false→bool, null→null, numeric→number
 *                    ONLY when the leaf field is known-numeric (so leading-zero
 *                    SKUs/barcodes stay strings), otherwise string
 *   key:=<json>      value parsed as raw JSON (explicit types/arrays/objects)
 *   a.b=value        nested object path
 *   arr[]=value      append to an array
 *
 * Price groups and attributes are intentionally NOT addressable via --set; they
 * have dedicated flags so their nested write shape is built correctly.
 */
export function parseSet(
  assignments: string[],
  numericFields: ReadonlySet<string> = NUMERIC_FIELDS,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const raw of assignments) {
    const jsonIdx = raw.indexOf(":=");
    const eqIdx = raw.indexOf("=");
    if (jsonIdx === -1 && eqIdx === -1) {
      throw new ValidationError(`Invalid --set "${raw}" (expected key=value or key:=json).`);
    }

    let key: string;
    let valueText: string;
    let isJson: boolean;
    if (jsonIdx !== -1 && (eqIdx === -1 || jsonIdx < eqIdx)) {
      key = raw.slice(0, jsonIdx);
      valueText = raw.slice(jsonIdx + 2);
      isJson = true;
    } else {
      key = raw.slice(0, eqIdx);
      valueText = raw.slice(eqIdx + 1);
      isJson = false;
    }

    key = key.trim();
    if (!key) throw new ValidationError(`Invalid --set "${raw}" (empty key).`);

    const value = isJson ? parseJson(valueText, raw) : coerceScalar(key, valueText, numericFields);
    setPath(out, key, value);
  }
  return out;
}

function parseJson(text: string, original: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new ValidationError(`Invalid JSON in --set "${original}".`);
  }
}

const NUMERIC_RE = /^-?\d+(\.\d+)?$/;

function coerceScalar(key: string, raw: string, numericFields: ReadonlySet<string>): unknown {
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (raw === "null") return null;
  if (numericFields.has(leafName(key)) && NUMERIC_RE.test(raw)) return Number(raw);
  return raw;
}

function leafName(path: string): string {
  const last = path.split(".").pop() ?? path;
  return last.replace(/\[\]$/, "");
}

function setPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split(".");
  let cur = obj;
  for (let i = 0; i < parts.length; i++) {
    let part = parts[i]!;
    const isLast = i === parts.length - 1;
    const isAppend = part.endsWith("[]");
    if (isAppend) part = part.slice(0, -2);

    if (isLast) {
      if (isAppend) {
        const existing = cur[part];
        const arr = Array.isArray(existing) ? existing : [];
        arr.push(value);
        cur[part] = arr;
      } else {
        cur[part] = value;
      }
      return;
    }

    const next = cur[part];
    if (typeof next !== "object" || next === null || Array.isArray(next)) {
      cur[part] = {};
    }
    cur = cur[part] as Record<string, unknown>;
  }
}
