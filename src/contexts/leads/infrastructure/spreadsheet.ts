import { CsvError, parseCsv, type ParsedCsv } from "./csv";
import { isOleBytes, isXlsxBytes, parseXlsx, type ParsedWorkbook } from "./xlsx";

export const SPREADSHEET_ACCEPT = ".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/**
 * CSV or XLSX, chosen by content first and the file name second. Both give the same headers and rows.
 * `sheet` (1-based) picks a workbook sheet; the leads importer leaves it out and reads sheet 1. CSV has no sheets.
 */
export async function parseSpreadsheet(buffer: Buffer, filename: string, options: { sheet?: number } = {}): Promise<ParsedCsv | ParsedWorkbook> {
  const name = filename.toLowerCase();
  if (name.endsWith(".xlsm") || name.endsWith(".xlsb")) {
    throw new CsvError("Workbooks with macros are not accepted. Save a copy as .xlsx without macros, or as CSV.");
  }
  if (isXlsxBytes(buffer) || isOleBytes(buffer) || name.endsWith(".xlsx") || name.endsWith(".xls")) return parseXlsx(buffer, options);
  return parseCsv(buffer);
}
