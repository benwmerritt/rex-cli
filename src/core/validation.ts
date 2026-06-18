import { ValidationError } from "./errors";

function textValue(value: unknown): string {
  return String(value).trim();
}

export function parsePositiveInt(value: unknown, paramName: string): number {
  const text = textValue(value);
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

export function parseOptionalPositiveInt(value: unknown, paramName: string): number | undefined {
  if (value === undefined) return undefined;
  const text = textValue(value);
  if (text === "") return undefined;
  return parsePositiveInt(text, paramName);
}

export function validateSafeProfileName(profile: string): string {
  if (
    profile.length === 0 ||
    profile === "." ||
    profile === ".." ||
    profile.includes("..") ||
    profile.includes("/") ||
    profile.includes("\\") ||
    !/^[A-Za-z0-9._-]+$/.test(profile)
  ) {
    throw new ValidationError("Unsafe profile name for filesystem path.", {
      details: {
        profile,
        allowed: "letters, numbers, dot, underscore, and hyphen",
      },
    });
  }
  return profile;
}
