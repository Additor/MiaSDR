/** Token substitution for provider requests and AI prompts. Tokens are `{{key}}`. */

import { SINGLE_TOKEN, TOKEN, normalizeKey } from "./keys";

export const tokensIn = (text: string | undefined | null): string[] => (text ? [...new Set([...text.matchAll(TOKEN)].map((m) => normalizeKey(m[1])))] : []);

export const cellText = (value: unknown): string => {
  if (value === null || value === undefined) return "";
  return typeof value === "object" ? JSON.stringify(value) : String(value);
};

/** A row's own value for `key`. Plain indexing also finds inherited names like "constructor". */
export const ownCell = (row: Record<string, unknown>, key: string): unknown => (Object.hasOwn(row, normalizeKey(key)) ? row[normalizeKey(key)] : undefined);

/** Replaces tokens from `values`, passing each through `encode`. A missing value becomes an empty string. */
export function render(template: string, values: Record<string, unknown>, encode: (text: string) => string = (t) => t): string {
  return template.replace(TOKEN, (_m, key: string) => encode(cellText(ownCell(values, key))));
}

/** A template that is exactly one token returns the value itself, so numbers and booleans keep their type. */
export function renderValue(template: string, values: Record<string, unknown>): unknown {
  const single = SINGLE_TOKEN.exec(template);
  if (single) return ownCell(values, single[1]) ?? null;
  return render(template, values);
}

/** Renders every string leaf of a JSON value. Keys are never templated, so an input cannot add a field. */
export function renderBody(node: unknown, values: Record<string, unknown>): unknown {
  if (typeof node === "string") return renderValue(node, values);
  if (Array.isArray(node)) return node.map((n) => renderBody(n, values));
  if (node && typeof node === "object") return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, renderBody(v, values)]));
  return node;
}

/** Reads `data.person.email` or `items.0.id` from a parsed response. */
export function pluck(value: unknown, path: string): unknown {
  let cur = value;
  for (const part of path.split(".")) {
    if (cur === null || cur === undefined) return null;
    if (Array.isArray(cur) && /^\d+$/.test(part)) cur = cur[Number(part)];
    else if (typeof cur === "object" && Object.hasOwn(cur, part)) cur = (cur as Record<string, unknown>)[part];
    else return null;
  }
  return cur ?? null;
}

/** A cell that holds something: not null, not blank text, not an empty list. */
export const hasCellValue = (value: unknown): boolean =>
  value !== undefined && value !== null && (!Array.isArray(value) || value.length > 0) && (typeof value !== "string" || value.trim() !== "");

/** Guard before a paid call: a blank or malformed value would cost a credit and find nothing. Returns a message or null. */
export function validateInput(type: string, value: unknown): string | null {
  if (!hasCellValue(value)) return "A value is required";
  if (type === "number") return typeof value === "number" && Number.isFinite(value) ? null : "Expected a number";
  if (type === "boolean") return typeof value === "boolean" ? null : "Expected true or false";
  if (type === "json") return typeof value === "object" ? null : "Expected JSON";
  const text = typeof value === "string" ? value.trim() : null;
  if (text === null) return "Expected text";
  if (text.length > 2000) return "The value is too long";
  if (type === "email") return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text) ? null : "Expected a valid email address";
  if (type === "url" || type === "domain") {
    try {
      const url = new URL(text.includes("://") ? text : `https://${text}`);
      if (type === "url" && url.protocol !== "http:" && url.protocol !== "https:") return "Expected an http or https URL";
      return url.hostname.includes(".") ? null : "Expected a domain";
    } catch {
      return "Expected a domain";
    }
  }
  return null;
}

/** "https://www.Acme.com/about" becomes "acme.com". */
export function normalizeDomain(value: string): string {
  const text = value.trim();
  try {
    return new URL(text.includes("://") ? text : `https://${text}`).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return text.toLowerCase();
  }
}
