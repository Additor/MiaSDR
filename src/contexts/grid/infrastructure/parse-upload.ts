import { CsvError } from "@/contexts/leads/infrastructure/csv";
import { parseSpreadsheet } from "@/contexts/leads/infrastructure/spreadsheet";
import { SheetContentError } from "@/contexts/leads/infrastructure/xlsx";
import { ValidationError } from "@/shared/errors";
import type { ParsedSheet } from "../application/import-export";

/**
 * Reads an uploaded CSV or XLSX with the leads importer's parsers: size and zip-bomb limits,
 * delimiter detection and unique headers. Formulas in a workbook are never evaluated. Every value is text.
 * `sheet` (1-based) picks a workbook sheet and defaults to the first. A sheet that is empty or has no data rows
 * comes back as a `problem` with the sheet list, so the preview can still offer the other sheets.
 */
export async function parseUpload(file: { name: string; bytes: Buffer }, options: { sheet?: number } = {}): Promise<ParsedSheet> {
  try {
    const parsed = await parseSpreadsheet(file.bytes, file.name, options);
    const { headers, rows } = parsed;
    return { headers, rows: rows.map((row) => headers.map((h) => row[h] ?? "")), ...("sheets" in parsed ? { sheets: parsed.sheets, sheet: parsed.sheet } : {}) };
  } catch (error) {
    if (error instanceof SheetContentError) return { headers: [], rows: [], sheets: error.sheets, sheet: error.sheet, problem: error.message };
    if (error instanceof CsvError) throw new ValidationError(error.message);
    throw error;
  }
}
