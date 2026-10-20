import { cleanString } from "./cell-values";

/** Longest string a provider or AI answer may store in a cell or ledger value. */
export const MAX_OUTPUT_STRING_CHARS = 20_000;
const MAX_KEY_CHARS = 200;
const MAX_ITEMS = 1000;
const MAX_DEPTH = 12;

// C0 controls except tab and newline, DEL, and the C1 range.
const CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g;

/** Makes one string safe to store: no NUL or control characters (tab and newline stay), no lone surrogates, bounded length. */
export function sanitizeOutputString(text: string, maxChars = MAX_OUTPUT_STRING_CHARS): string {
  const stripped = text.replace(/\r\n?/g, "\n").replace(CONTROL, "");
  // Slicing can cut a surrogate pair in half, so clean after the cut.
  return cleanString(stripped.length > maxChars ? stripped.slice(0, maxChars) : stripped);
}

/**
 * Deep-cleans a provider or AI value before any write. Strings and object keys are sanitized, numbers that JSON
 * cannot hold become null, and depth and width are bounded so a hostile document cannot grow the write without limit.
 */
export function sanitizeOutput<T>(value: T, depth = 0): T {
  if (typeof value === "string") return sanitizeOutputString(value) as T;
  if (typeof value === "number") return (Number.isFinite(value) ? value : null) as T;
  if (typeof value === "bigint") return value.toString() as T;
  if (value === null || value === undefined || typeof value === "boolean") return value;
  if (typeof value !== "object") return null as T;
  if (value instanceof Date) return (Number.isNaN(value.getTime()) ? null : value.toISOString()) as T;
  if (depth >= MAX_DEPTH) return null as T;
  if (Array.isArray(value)) return value.slice(0, MAX_ITEMS).map((item) => sanitizeOutput(item, depth + 1)) as T;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value).slice(0, MAX_ITEMS)) out[sanitizeOutputString(key, MAX_KEY_CHARS)] = sanitizeOutput(item, depth + 1);
  return out as T;
}
