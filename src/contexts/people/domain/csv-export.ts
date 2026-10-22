/** Excel and Sheets run a cell as a formula when it starts with one of these. */
const FORMULA_START = /^[=+\-@\t\r]/;

/**
 * One CSV cell. A value that starts with = + - @ tab or CR gets a leading
 * single quote so a spreadsheet shows it as text instead of running it. The
 * cell is quoted when it holds a comma, quote, CR or LF.
 */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  let text = value instanceof Date ? value.toISOString() : String(value);
  if (FORMULA_START.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** A CRLF-terminated line (RFC 4180). */
export function csvLine(values: unknown[]): string {
  return `${values.map(csvCell).join(",")}\r\n`;
}

/** Lets Excel read the file as UTF-8, so Korean text does not turn into mojibake. */
export const UTF8_BOM = "﻿";
