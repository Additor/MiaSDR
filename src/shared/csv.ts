/** UTF-8 byte-order mark. Excel uses it to detect UTF-8. */
export const UTF8_BOM = "﻿";

/**
 * Text that starts with one of these runs as a formula in Excel and Sheets. Whitespace before the
 * operator counts too, because spreadsheets trim it. Leading apostrophes count so that
 * neutralizeFormula and restoreFormula are exact inverses, even for text that already starts with one.
 */
const ESCAPED_FORMULA = /^'*(?:\s*[=+\-@]|[\t\r\n])/;

/** Prefixes a risky string with an apostrophe so a spreadsheet shows it as text. */
export function neutralizeFormula(text: string): string {
  return ESCAPED_FORMULA.test(text) ? `'${text}` : text;
}

/**
 * Reverses neutralizeFormula on import, so an exported file reads back as it was written.
 * Only an apostrophe in front of text that would have been neutralized is removed.
 */
export function restoreFormula(text: string): string {
  return text.startsWith("'") && ESCAPED_FORMULA.test(text.slice(1)) ? text.slice(1) : text;
}

function printable(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return neutralizeFormula(value);
  if (typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") return String(value);
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") return JSON.stringify(value) ?? "";
  return String(value);
}

/** One CSV field with RFC 4180 quoting. Formula-like text gets a leading apostrophe. */
export function csvCell(value: unknown): string {
  const text = printable(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** A CRLF-terminated line. */
export function csvLine(values: readonly unknown[]): string {
  return `${values.map(csvCell).join(",")}\r\n`;
}
