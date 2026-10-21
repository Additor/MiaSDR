import { readSheet } from "read-excel-file/universal";
import { unzipSync, zipSync } from "fflate";
import { CsvError, MAX_FILE_BYTES, uniqueHeaders, type ParsedCsv } from "./csv";

/*
 * XLSX is a zip of XML files, so the risks are a zip bomb, macros and hostile
 * cell content. Parser: read-excel-file (see docs/decisions.md). Before it sees
 * a byte we unzip with fflate under hard size limits, keep only the parts a
 * plain sheet needs, and hand it a fresh archive whose sizes we measured
 * ourselves. Formulas are never evaluated: only the cached value of a cell is
 * read, and every value becomes text.
 */

export const MAX_XLSX_ROWS = 10_000;
export const MAX_XLSX_COLUMNS = 200;
export const MAX_CELL_CHARS = 5_000;
/** Total inflated size of the parts we keep. A 5 MB sheet of real data inflates to a few tens of MB. */
export const MAX_INFLATED_BYTES = 64 * 1024 * 1024;
const MAX_ZIP_ENTRIES = 2_000;
/** A real workbook.xml is a few KB. One megabyte is already a hostile file, and the sheet scan below stays cheap under it. */
export const MAX_WORKBOOK_XML_BYTES = 1024 * 1024;
/** Excel allows 31 characters in a sheet name and a few hundred sheets at most. */
export const MAX_SHEETS = 255;
export const MAX_SHEET_NAME_CHARS = 255;

const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04];
const OLE_MAGIC = [0xd0, 0xcf, 0x11, 0xe0];

const startsWith = (bytes: Uint8Array, magic: number[]) => magic.every((b, i) => bytes[i] === b);

export const isXlsxBytes = (bytes: Uint8Array) => startsWith(bytes, ZIP_MAGIC);
export const isOleBytes = (bytes: Uint8Array) => startsWith(bytes, OLE_MAGIC);

/** The only parts a sheet needs. Drawings, media, external links and VBA never reach the parser. */
const KEEP = [
  /^\[Content_Types\]\.xml$/,
  /^_rels\/\.rels$/,
  /^xl\/workbook\.xml$/,
  /^xl\/_rels\/workbook\.xml\.rels$/,
  /^xl\/sharedStrings\.xml$/,
  /^xl\/styles\.xml$/,
  /^xl\/worksheets\/[^/]+\.xml$/,
];

const MACRO_PART = /vbaProject\.bin$/i;

/** A sheet that cannot be imported (empty, or a header with no data). Carries the sheet list so a picker can still offer the others. */
export class SheetContentError extends CsvError {
  constructor(
    message: string,
    readonly sheets: string[],
    readonly sheet: number,
  ) {
    super(message);
  }
}

export interface ParsedWorkbook extends ParsedCsv {
  /** Sheet names in workbook order. */
  sheets: string[];
  /** The 1-based sheet these rows come from. */
  sheet: number;
}

const XML_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function decodeXml(text: string): string {
  return text.replace(/&(?:#x([0-9a-f]+)|#(\d+)|(amp|lt|gt|quot|apos));/gi, (_, hex: string | undefined, dec: string | undefined, named: string | undefined) => {
    if (named) return XML_ENTITIES[named.toLowerCase()];
    const code = hex ? Number.parseInt(hex, 16) : Number(dec);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
  });
}

/** Sheet names from `xl/workbook.xml`, in the order read-excel-file numbers them. */
export function sheetNames(workbookXml: string): string[] {
  if (workbookXml.length > MAX_WORKBOOK_XML_BYTES) throw new CsvError("The workbook index is too large to be a normal spreadsheet.");
  const names: string[] = [];
  // `[^<]*` (not `[^>]*`): a run of `<sheet <sheet ...` with no `>` then fails each start at the next `<` instead of rescanning to the end.
  for (const tag of workbookXml.matchAll(/<(?:[\w-]+:)?sheet(?=[\s/>])[^<]*>/g)) {
    const name = /\sname\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(tag[0]);
    const value = name ? (name[1] ?? name[2]) : undefined;
    if (!value) continue;
    if (value.length > MAX_SHEET_NAME_CHARS) throw new CsvError(`A sheet name is longer than ${MAX_SHEET_NAME_CHARS} characters.`);
    if (names.length >= MAX_SHEETS) throw new CsvError(`The workbook has more than ${MAX_SHEETS} sheets.`);
    names.push(decodeXml(value));
  }
  return names;
}

function sanitize(bytes: Uint8Array): { bytes: Uint8Array; sheets: string[] } {
  let inflated = 0;
  let entries = 0;
  let macro = false;
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes, {
      filter: (file) => {
        entries += 1;
        if (entries > MAX_ZIP_ENTRIES) throw new CsvError("The workbook has too many parts to be a normal spreadsheet.");
        if (MACRO_PART.test(file.name)) macro = true;
        if (!KEEP.some((pattern) => pattern.test(file.name))) return false;
        // Declared size. A lie is caught below: fflate inflates into a buffer of exactly this size.
        inflated += file.originalSize;
        if (file.originalSize > MAX_INFLATED_BYTES || inflated > MAX_INFLATED_BYTES) {
          throw new CsvError("The workbook is too large once unpacked. Export the sheet as CSV instead.");
        }
        return true;
      },
    });
  } catch (error) {
    if (error instanceof CsvError) throw error;
    throw new CsvError("The file could not be read as an .xlsx workbook.");
  }
  if (macro) throw new CsvError("Workbooks with macros are not accepted. Save a copy as .xlsx without macros, or as CSV.");

  const contentTypes = files["[Content_Types].xml"];
  if (!contentTypes || !files["xl/workbook.xml"]) throw new CsvError("The file is not an Excel workbook.");
  if (files["xl/workbook.xml"].byteLength > MAX_WORKBOOK_XML_BYTES) throw new CsvError("The workbook index is too large to be a normal spreadsheet.");
  if (/macroEnabled/i.test(new TextDecoder().decode(contentTypes))) {
    throw new CsvError("Workbooks with macros are not accepted. Save a copy as .xlsx without macros, or as CSV.");
  }
  let total = 0;
  for (const part of Object.values(files)) total += part.byteLength;
  if (total > MAX_INFLATED_BYTES) throw new CsvError("The workbook is too large once unpacked. Export the sheet as CSV instead.");
  return { bytes: zipSync(files, { level: 0 }), sheets: sheetNames(new TextDecoder().decode(files["xl/workbook.xml"])) };
}

function cellText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) {
    const iso = value.toISOString();
    return iso.endsWith("T00:00:00.000Z") ? iso.slice(0, 10) : iso;
  }
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  return String(value).trim();
}

export interface ParseXlsxOptions {
  /** 1-based sheet number. Defaults to the first sheet, which is what the leads importer reads. */
  sheet?: number;
}

/** One sheet of an .xlsx file (the first by default) as headers and rows, the same shape the CSV parser returns, plus the sheet list. */
export async function parseXlsx(buffer: Buffer | Uint8Array, options: ParseXlsxOptions = {}): Promise<ParsedWorkbook> {
  if (buffer.byteLength > MAX_FILE_BYTES) throw new CsvError(`The file is larger than ${MAX_FILE_BYTES / 1024 / 1024} MB.`);
  const bytes = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  if (isOleBytes(bytes)) throw new CsvError("This looks like an old .xls file or a password-protected workbook. Save it as .xlsx or CSV without a password.");
  if (!isXlsxBytes(bytes)) throw new CsvError("The file is not an .xlsx workbook.");

  const { bytes: clean, sheets } = sanitize(bytes);
  const sheet = options.sheet ?? 1;
  if (!Number.isInteger(sheet) || sheet < 1 || sheet > Math.max(sheets.length, 1)) {
    throw new CsvError(`The workbook has ${sheets.length} sheet${sheets.length === 1 ? "" : "s"}. Choose a sheet from 1 to ${sheets.length}.`);
  }
  const label = sheet === 1 ? "The first sheet" : `Sheet "${sheets[sheet - 1]}"`;
  let grid: unknown[][];
  try {
    const arrayBuffer = clean.buffer.slice(clean.byteOffset, clean.byteOffset + clean.byteLength) as ArrayBuffer;
    grid = (await readSheet(arrayBuffer, sheet, { parseNumber: (text: string) => text, trim: true })) as unknown[][];
  } catch {
    throw new CsvError("The file could not be read as an .xlsx workbook.");
  }

  const headerIndex = grid.findIndex((row) => row.some((cell) => cellText(cell) !== ""));
  if (headerIndex === -1) throw new SheetContentError(`${label} is empty.`, sheets, sheet);
  const rawHeaders = grid[headerIndex].map(cellText);
  while (rawHeaders.length > 0 && rawHeaders[rawHeaders.length - 1] === "") rawHeaders.pop();
  if (rawHeaders.length > MAX_XLSX_COLUMNS) throw new CsvError(`The sheet has more than ${MAX_XLSX_COLUMNS} columns.`);
  const headers = uniqueHeaders(rawHeaders);

  const dataRows = grid.slice(headerIndex + 1);
  if (dataRows.length > MAX_XLSX_ROWS + 1_000) {
    // Blank rows trimmed below could bring it under the limit, but a sheet this long is not a lead list.
    throw new CsvError(`The sheet has ${dataRows.length} rows. The limit is ${MAX_XLSX_ROWS}; split it and import in parts.`);
  }
  const rows: Array<Record<string, string>> = [];
  for (const [offset, cells] of dataRows.entries()) {
    const record: Record<string, string> = {};
    let any = false;
    for (let i = 0; i < headers.length; i += 1) {
      const text = cellText(cells[i]);
      if (text.length > MAX_CELL_CHARS) {
        throw new CsvError(`A cell in row ${headerIndex + offset + 2} is longer than ${MAX_CELL_CHARS} characters.`);
      }
      record[headers[i]] = text;
      if (text !== "") any = true;
    }
    if (any) rows.push(record);
  }
  if (rows.length === 0) throw new SheetContentError(sheet === 1 ? "The sheet has a header row but no data rows." : `Sheet "${sheets[sheet - 1]}" has a header row but no data rows.`, sheets, sheet);
  return { headers, rows, sheets, sheet };
}
