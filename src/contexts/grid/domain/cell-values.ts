import type { StaticColumnType } from "./column-types";

/** Hard cap on one text cell. A longer value is rejected at the edge. */
export const MAX_CELL_CHARS = 20_000;

/**
 * Makes a string safe for a jsonb column. Postgres rejects \u0000 in text and jsonb,
 * and a lone surrogate serializes to an escape that jsonb rejects too.
 */
export function cleanString(text: string): string {
  return text.replace(/\u0000/g, "").replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "�");
}

/** Deep-cleans strings and object keys. Past depth 20 the value becomes null so a hostile document cannot recurse forever. */
export function cleanJson<T>(value: T, depth = 0): T {
  if (typeof value === "string") return cleanString(value) as T;
  if (!value || typeof value !== "object") return value;
  if (depth > 20) return null as T;
  if (Array.isArray(value)) return value.map((item) => cleanJson(item, depth + 1)) as T;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) out[cleanString(key)] = cleanJson(item, depth + 1);
  return out as T;
}

const CURRENCY_SYMBOLS = /[$€£¥₹₩]/g;
const CURRENCY_CODES = /^(?:USD|EUR|GBP|JPY|INR|CAD|AUD|CHF|CNY|SGD|AED|KRW)\s*|\s*(?:USD|EUR|GBP|JPY|INR|CAD|AUD|CHF|CNY|SGD|AED|KRW)$/i;
const DECIMAL_TEXT = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i;

/**
 * Reads a number the way a person writes it: "1,234.5", "$1,234.50", "USD 12", "-$5", "(1,200)".
 * Returns null when the text is not entirely a number, so "N/A", "12abc" and "50%" stay text.
 */
export function parseNumericText(text: string): number | null {
  if (text.length > 64) return null;
  let value = text.trim();
  if (!value) return null;
  let negative = false;
  const wrapped = /^\((.*)\)$/.exec(value);
  if (wrapped) {
    negative = true;
    value = wrapped[1].trim();
  }
  value = value.replace(CURRENCY_CODES, "").replace(CURRENCY_SYMBOLS, "").replace(/,/g, "").replace(/\s+/g, "");
  if (!DECIMAL_TEXT.test(value)) return null;
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return negative ? -number : number;
}

/**
 * Coerces a pasted or imported string to the stored shape of a static column.
 * A value that does not fit ("N/A" in a number column) stays as typed: a type
 * change or an import must never destroy data. Only blank text becomes null.
 */
export function coerceText(raw: string, type: StaticColumnType): unknown {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  switch (type) {
    case "number":
    case "currency":
      return parseNumericText(trimmed) ?? raw;
    case "boolean": {
      const normalized = trimmed.toLowerCase();
      if (["true", "yes", "y", "1"].includes(normalized)) return true;
      if (["false", "no", "n", "0"].includes(normalized)) return false;
      return raw;
    }
    case "json":
      try {
        return JSON.parse(raw);
      } catch {
        return raw;
      }
    case "multiselect":
      return raw.split(/[;,]/).map((v) => v.trim()).filter(Boolean);
    default:
      return raw;
  }
}

export type CellInput = { ok: true; value: unknown } | { ok: false; error: string };

const reject = (error: string): CellInput => ({ ok: false, error });

/** Turns a value sent to the cells endpoint into what the column's type stores. */
export function coerceCellInput(value: unknown, type: StaticColumnType): CellInput {
  if (value === null || value === undefined) return { ok: true, value: null };
  const text = typeof value === "string" ? cleanString(value) : null;
  if (text !== null && text.length > MAX_CELL_CHARS) return reject(`must be ${MAX_CELL_CHARS.toLocaleString("en-US")} characters or fewer`);

  switch (type) {
    case "number":
    case "currency": {
      if (typeof value === "number") return Number.isFinite(value) ? { ok: true, value } : reject("must be a finite number");
      return text === null ? reject("must be a number") : { ok: true, value: coerceText(text, type) };
    }
    case "boolean": {
      if (typeof value === "boolean") return { ok: true, value };
      return text === null ? reject("must be true or false") : { ok: true, value: coerceText(text, type) };
    }
    case "date": {
      if (text === null) return reject("must be a date");
      const trimmed = text.trim();
      return { ok: true, value: trimmed === "" ? null : trimmed };
    }
    case "json": {
      if (text === null) {
        const cleaned = cleanJson(value);
        return JSON.stringify(cleaned).length > MAX_CELL_CHARS ? reject("is too large") : { ok: true, value: cleaned };
      }
      return { ok: true, value: coerceText(text, type) };
    }
    case "multiselect": {
      if (Array.isArray(value)) {
        if (value.length > 200 || !value.every((v) => typeof v === "string")) return reject("must be a list of up to 200 text values");
        return { ok: true, value: value.map((v) => cleanString(v as string)) };
      }
      return text === null ? reject("must be a list of text values") : { ok: true, value: coerceText(text, type) };
    }
    default: {
      if (text !== null) return { ok: true, value: text };
      if (typeof value === "number" || typeof value === "boolean") return { ok: true, value: String(value) };
      return reject("must be text");
    }
  }
}

const TEXT_TARGETS: ReadonlySet<StaticColumnType> = new Set(["text", "email", "url", "image", "select", "date"]);

/** One stored value re-expressed for a new static column type. What does not convert stays as it was. */
export function convertStoredValue(value: unknown, to: StaticColumnType): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    if (!value.trim()) return null;
    const converted = coerceText(value, to);
    return converted === null || converted === undefined ? value : converted;
  }
  if (Array.isArray(value)) {
    if (!TEXT_TARGETS.has(to)) return value;
    return value.every((item) => item === null || typeof item !== "object") ? value.map(String).join(", ") : JSON.stringify(value);
  }
  if (typeof value === "number" || typeof value === "boolean") {
    if (TEXT_TARGETS.has(to)) return String(value);
    if (to === "boolean" && (value === 1 || value === 0)) return value === 1;
    return value;
  }
  return TEXT_TARGETS.has(to) ? JSON.stringify(value) : value;
}

export function isBlankValue(value: unknown): boolean {
  return value === null || value === undefined || (typeof value === "string" && value.trim() === "");
}
