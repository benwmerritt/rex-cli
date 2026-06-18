import type { Writer } from "../../src/core/output";

export function capture(): { writer: Writer; text: () => string } {
  const chunks: string[] = [];
  const writer: Writer = { write: (text) => void chunks.push(text) };
  return { writer, text: () => chunks.join("") };
}
