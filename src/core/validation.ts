import { ValidationError } from "./errors";

export function parsePositiveInt(value: unknown, paramName: string): number {
  const text = String(value).trim();
  if (!/^\d+$/.test(text)) throw new ValidationError(`${paramName} must be a positive integer.`);
  const parsed = Number.parseInt(text, 10);
  if (parsed <= 0) {
    throw new ValidationError(`${paramName} must be a positive integer.`);
  }
  if (!Number.isSafeInteger(parsed)) {
    throw new ValidationError(`${paramName} is out of range; must not exceed Number.MAX_SAFE_INTEGER.`);
  }
  return parsed;
}

export function parseOptionalPositiveInt(value: string | undefined, paramName: string): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  return parsePositiveInt(value, paramName);
}
