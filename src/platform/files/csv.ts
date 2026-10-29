import { parse } from "csv-parse/sync";
import { ValidationError } from "@/shared/errors";

export const MAX_FILE_BYTES = 5 * 1024 * 1024;

/** A file that cannot be read as a sheet of leads. A `ValidationError`, so a route wrapper answers 422 with the message. */
export class CsvError extends ValidationError {}

export interface ParsedCsv {
  headers: string[];
  rows: Array<Record<string, string>>;
}

/** Makes repeated or empty headers unique so no column is lost: "Email", "Email (2)", "Column 3". */
export function uniqueHeaders(raw: string[]): string[] {
  const seen = new Map<string, number>();
  return raw.map((header, index) => {
    const base = header.trim() || `Column ${index + 1}`;
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    return count === 1 ? base : `${base} (${count})`;
  });
}

/** Detects comma, semicolon or tab from the header line. Excel in many locales saves with semicolons. */
function detectDelimiter(text: string): string {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
  const [best] = [",", ";", "\t"]
    .map((d) => ({ d, n: firstLine.split(d).length - 1 }))
    .sort((a, b) => b.n - a.n);
  return best.n > 0 ? best.d : ",";
}

export function parseCsv(buffer: Buffer): ParsedCsv {
  if (buffer.byteLength > MAX_FILE_BYTES) {
    throw new CsvError(`The file is larger than ${MAX_FILE_BYTES / 1024 / 1024} MB.`);
  }
  const text = buffer.toString("utf8").replace(/^﻿/, "");
  if (text.trim() === "") throw new CsvError("The file is empty.");
  if (text.includes("\u0000")) throw new CsvError("The file is not a text CSV. Export it as CSV or upload an .xlsx workbook.");

  let headers: string[] = [];
  try {
    const records = parse(text, {
      delimiter: detectDelimiter(text),
      columns: (first: string[]) => (headers = uniqueHeaders(first)),
      skip_empty_lines: true,
      relax_column_count: true,
      relax_quotes: true,
      trim: true,
    }) as Array<Record<string, string>>;
    if (records.length === 0) throw new CsvError("The file has a header row but no leads.");
    return { headers, rows: records };
  } catch (error) {
    if (error instanceof CsvError) throw error;
    throw new CsvError(`The file could not be read as CSV: ${error instanceof Error ? error.message : "unknown error"}`);
  }
}
