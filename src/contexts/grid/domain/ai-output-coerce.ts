/**
 * Checks and converts one AI answer to the type of its output column, before the write. The model answers email,
 * url, date and json fields as text; a wrong answer ("next Tuesday" for a date) must not land in a typed column.
 * A rejected value is not retried: the call already ran and was paid for. The caller stores the message as the cell's error.
 */

export const MAX_AI_EMAIL_CHARS = 254;
export const MAX_AI_URL_CHARS = 2048;
/** Longest JSON text accepted for a json output, and the longest a stored value may serialize to. */
export const MAX_AI_JSON_CHARS = 5000;
/** Longest text answer. The provider schema leaves the length open so an over-long answer lands here as a cell error and is not retried (and paid for) as a shape failure. */
export const MAX_AI_TEXT_CHARS = 5000;

export type AiCoercion = { ok: true; value: string | number | boolean | object | null } | { ok: false; message: string };

const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
/** A cell that starts with one of these is read as a formula by a spreadsheet that opens an export. */
const FORMULA_LEAD = /^[=+\-@]/;

const reject = (message: string): AiCoercion => ({ ok: false, message });
const EMAIL = /^[^\s@<>()[\],;:"]+@[^\s@<>()[\],;:"]+\.[^\s@<>()[\],;:"]{2,}$/;

function isRealDate(year: number, month: number, day: number): boolean {
  const d = new Date(Date.UTC(year, month - 1, day));
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
}

/** `null`, undefined and blank text mean "not found" and store an empty cell for every type. */
export function coerceAiOutput(type: string, raw: unknown): AiCoercion {
  if (raw === null || raw === undefined) return { ok: true, value: null };
  if (typeof raw === "string" && raw.trim() === "") return { ok: true, value: null };
  switch (type) {
    case "number":
      return typeof raw === "number" && Number.isFinite(raw) ? { ok: true, value: raw } : reject("The answer is not a number.");
    case "boolean":
      return typeof raw === "boolean" ? { ok: true, value: raw } : reject("The answer is not yes or no.");
    case "email": {
      const text = typeof raw === "string" ? raw.trim() : "";
      if (text.length > MAX_AI_EMAIL_CHARS || !EMAIL.test(text) || text.includes("..") || FORMULA_LEAD.test(text) || CONTROL.test(text)) return reject(`"${preview(raw)}" is not an email address.`);
      return { ok: true, value: text };
    }
    case "url": {
      const text = typeof raw === "string" ? raw.trim() : "";
      if (text.length > MAX_AI_URL_CHARS) return reject("The URL is too long.");
      if (/\s/.test(text) || CONTROL.test(text)) return reject(`"${preview(raw)}" is not a URL. A URL has no spaces or line breaks.`);
      try {
        const url = new URL(text);
        if ((url.protocol !== "http:" && url.protocol !== "https:") || !url.hostname.includes(".")) return reject(`"${preview(raw)}" is not an http or https URL.`);
        return { ok: true, value: text };
      } catch {
        return reject(`"${preview(raw)}" is not a URL. A URL starts with http:// or https://.`);
      }
    }
    case "date": {
      const text = typeof raw === "string" ? raw.trim() : "";
      const match = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/.exec(text);
      if (!match || !isRealDate(Number(match[1]), Number(match[2]), Number(match[3]))) return reject(`"${preview(raw)}" is not a date. Use YYYY-MM-DD.`);
      return { ok: true, value: `${match[1]}-${match[2]}-${match[3]}` };
    }
    case "json": {
      if (typeof raw !== "string") return raw !== null && typeof raw === "object" ? sizeChecked(raw) : reject("The answer is not JSON.");
      if (raw.length > MAX_AI_JSON_CHARS) return reject(`The JSON is longer than ${MAX_AI_JSON_CHARS.toLocaleString("en-US")} characters.`);
      try {
        const parsed: unknown = JSON.parse(raw);
        if (parsed === null) return { ok: true, value: null };
        return typeof parsed === "object" ? sizeChecked(parsed) : reject("The JSON must be an object or a list.");
      } catch {
        return reject("The answer is not valid JSON.");
      }
    }
    default: {
      const text = typeof raw === "string" ? raw : String(raw);
      return text.length > MAX_AI_TEXT_CHARS ? reject(`The answer is longer than ${MAX_AI_TEXT_CHARS.toLocaleString("en-US")} characters.`) : { ok: true, value: text };
    }
  }
}

function sizeChecked(value: unknown): AiCoercion {
  const text = JSON.stringify(value);
  if (text.length > MAX_AI_JSON_CHARS) return reject(`The JSON is longer than ${MAX_AI_JSON_CHARS.toLocaleString("en-US")} characters.`);
  return { ok: true, value: value as object };
}

const preview = (raw: unknown) => String(raw).replace(/\s+/g, " ").slice(0, 60);
