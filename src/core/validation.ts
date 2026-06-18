import { ValidationError } from "./errors";

export function parsePositiveInt(value: unknown, paramName: string): number {
  const text = String(value).trim();
  if (!/^\d+$/.test(text)) throw new ValidationError(`${paramName} must be a positive integer.`);
  const parsed = Number.parseInt(text, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new ValidationError(`${paramName} must be a positive integer.`);
  }
  return parsed;
}
