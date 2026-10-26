import { ValidationError } from "@/shared/errors";
import { MAX_CELL_CHARS, cleanJson, cleanString, coerceText, isBlankValue, parseNumericText } from "./cell-values";
import { isStaticColumnType, type StaticColumnType } from "./column-types";
import { restoreFormula } from "@/shared/csv";
import { MAX_NAME_LENGTH, toColumnKey, uniqueColumnKey, uniqueColumnName } from "./keys";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const URL_RE = /^https?:\/\/\S+$/i;
const BOOL_VALUES = new Set(["true", "false", "yes", "no", "y", "n", "1", "0"]);
/** Share of non-empty samples that must fit a number or date type; the rest stay raw strings. */
const MAJORITY = 0.9;

const MONTH = "(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?";
const DATE_SHAPES: RegExp[] = [
  /^\d{4}[-/]\d{1,2}[-/]\d{1,2}(?:[T ]\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:\s?[AP]M)?(?:Z|[+-]\d{2}:?\d{2})?)?$/i,
  /^\d{1,2}[/.-]\d{1,2}[/.-](?:\d{4}|\d{2})(?:[ T]\d{1,2}:\d{2}(?::\d{2})?(?:\s?[AP]M)?)?$/i,
  new RegExp(`^${MONTH}\\s+\\d{1,2}(?:st|nd|rd|th)?,?\\s+\\d{4}$`, "i"),
  new RegExp(`^\\d{1,2}(?:st|nd|rd|th)?\\s+${MONTH},?\\s+\\d{4}$`, "i"),
];

/** True for text with the shape of a calendar date, not merely something Date.parse tolerates. */
export function looksLikeDate(value: string): boolean {
  const text = value.trim();
  if (text.length > 40 || !DATE_SHAPES.some((shape) => shape.test(text))) return false;
  const numeric = /^(\d{1,2})[/.-](\d{1,2})[/.-]\d{2,4}/.exec(text);
  if (numeric) {
    const [a, b] = [Number(numeric[1]), Number(numeric[2])];
    return a >= 1 && b >= 1 && a <= 31 && b <= 31 && (a <= 12 || b <= 12);
  }
  const iso = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/.exec(text);
  if (iso) return Number(iso[2]) >= 1 && Number(iso[2]) <= 12 && Number(iso[3]) >= 1 && Number(iso[3]) <= 31;
  return !Number.isNaN(Date.parse(text));
}

/** A number as a person writes it. Zip-code-like "02134" and 16+ digit ids stay text. */
function looksNumeric(value: string): boolean {
  if (/^[+-]?0\d/.test(value.trim())) return false;
  if (/^[+-]?\d{16,}$/.test(value.trim())) return false;
  return parseNumericText(value) !== null;
}

/** Guesses a column type from sample values so an imported file arrives with sensible types. */
export function inferColumnType(samples: readonly string[]): StaticColumnType {
  const values = samples.map((s) => s.trim()).filter(Boolean);
  if (values.length === 0) return "text";
  const mostly = (test: (v: string) => boolean) => values.filter(test).length / values.length >= MAJORITY;
  if (values.every((v) => EMAIL_RE.test(v))) return "email";
  if (values.every((v) => URL_RE.test(v))) return "url";
  // A column of only 0s and 1s is far more often a count than a yes/no question.
  if (values.every((v) => v === "0" || v === "1")) return "number";
  if (values.every((v) => BOOL_VALUES.has(v.toLowerCase()))) return "boolean";
  if (mostly(looksNumeric)) return "number";
  if (mostly(looksLikeDate)) return "date";
  return "text";
}

export type ColumnMapping =
  | { headerIndex: number; action: "map"; columnKey: string }
  | { headerIndex: number; action: "create"; name: string; type: StaticColumnType }
  | { headerIndex: number; action: "skip" };

/** Reuses an existing column when the header matches one (by key or name), otherwise proposes a new column with an inferred type. */
export function suggestMapping(headers: readonly string[], rows: ReadonlyArray<readonly string[]>, columns: ReadonlyArray<{ key: string; name: string }>): ColumnMapping[] {
  // The untouched starter column only matches a "name" header by accident. Leave it for the import to replace.
  const existing = isInitialSeedColumn(columns) ? [] : columns;
  const byKey = new Map(existing.map((c) => [c.key.toLowerCase(), c]));
  const byName = new Map(existing.map((c) => [c.name.trim().toLowerCase(), c]));
  const used = new Set<string>();
  return headers.map((header, headerIndex) => {
    if (!header.trim()) return { headerIndex, action: "skip" as const };
    const match = byKey.get(toColumnKey(header).toLowerCase()) ?? byName.get(header.trim().toLowerCase());
    if (match && !used.has(match.key)) {
      used.add(match.key);
      return { headerIndex, action: "map" as const, columnKey: match.key };
    }
    const samples = rows.slice(0, 50).map((r) => r[headerIndex] ?? "");
    return { headerIndex, action: "create" as const, name: header.trim().slice(0, MAX_NAME_LENGTH), type: inferColumnType(samples) };
  });
}

/** Validates a client-supplied mapping and fills in what it left out (a new column's name defaults to its header). */
export function normalizeMapping(raw: unknown, headers: readonly string[], knownKeys: ReadonlySet<string>): ColumnMapping[] {
  if (!Array.isArray(raw)) throw new ValidationError("mapping must be an array");
  if (raw.length > headers.length) throw new ValidationError("mapping has more entries than the file has columns");
  const seen = new Set<number>();
  const mappedKeys = new Set<string>();
  const mapping: ColumnMapping[] = [];
  for (const entry of raw as unknown[]) {
    if (typeof entry !== "object" || entry === null) throw new ValidationError("every mapping entry must be an object");
    const m = entry as Record<string, unknown>;
    const index = m.headerIndex;
    if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || index >= headers.length) {
      throw new ValidationError("headerIndex must point at a column in the file");
    }
    if (seen.has(index)) throw new ValidationError(`file column ${index + 1} is mapped more than once`);
    seen.add(index);
    if (m.action === "skip") {
      mapping.push({ headerIndex: index, action: "skip" });
    } else if (m.action === "map") {
      if (typeof m.columnKey !== "string" || !knownKeys.has(m.columnKey)) throw new ValidationError(`mapping targets unknown column "${String(m.columnKey)}"`);
      if (mappedKeys.has(m.columnKey)) throw new ValidationError(`more than one file column maps to "${m.columnKey}"`);
      mappedKeys.add(m.columnKey);
      mapping.push({ headerIndex: index, action: "map", columnKey: m.columnKey });
    } else if (m.action === "create") {
      if (typeof m.type !== "string" || !isStaticColumnType(m.type)) throw new ValidationError(`"${String(m.type)}" is not a column type an import can create`);
      if (m.name !== undefined && typeof m.name !== "string") throw new ValidationError("a new column's name must be text");
      const name = (typeof m.name === "string" ? m.name.trim() : "") || headers[index].trim();
      if (!name) throw new ValidationError(`name the new column for file column ${index + 1}`);
      if (name.length > MAX_NAME_LENGTH) throw new ValidationError(`column names must be ${MAX_NAME_LENGTH} characters or fewer`);
      mapping.push({ headerIndex: index, action: "create", name, type: m.type });
    } else {
      throw new ValidationError("mapping action must be map, create or skip");
    }
  }
  return mapping;
}

/** A fresh table holds one empty row and one "New Column". An import replaces both placeholders. */
export const isInitialPlaceholderRow = (rows: ReadonlyArray<{ cells: Record<string, unknown>; cellMeta: Record<string, unknown> }>): boolean =>
  rows.length === 1 && Object.keys(rows[0].cells).length === 0 && Object.keys(rows[0].cellMeta).length === 0;

export const SEED_COLUMN_KEY = "name";
export const SEED_COLUMN_NAME = "New Column";
/**
 * True for the table's only column when it is still the untouched starter. A seed with `config` or `dependsOn`
 * (someone made it a formula) or any sibling column is kept as is: the import renames the seed's key and migrates nothing else.
 */
export const isInitialSeedColumn = (columns: ReadonlyArray<{ key: string; name: string; config?: Record<string, unknown>; dependsOn?: readonly string[] }>): boolean =>
  columns.length === 1 &&
  columns[0].key === SEED_COLUMN_KEY &&
  columns[0].name === SEED_COLUMN_NAME &&
  Object.keys(columns[0].config ?? {}).length === 0 &&
  (columns[0].dependsOn ?? []).length === 0;

export interface PlannedColumn {
  key: string;
  name: string;
  type: StaticColumnType;
  /** Set when the import reuses the seed column instead of inserting one. */
  reuseExisting: boolean;
  /** The seed column's key before the import gave it the key of its header. Only set with `reuseExisting`. */
  replacesKey?: string;
}

export interface ImportPlan {
  /** Columns to insert, and the seed column to rename and retype when `reuseSeed` applies. */
  newColumns: PlannedColumn[];
  /** Header index to the column key its values land in. */
  targets: Map<number, string>;
  /** Column key to type, for coercion. */
  types: Map<string, StaticColumnType | string>;
}

/** Works out which columns an import creates and where each file column lands. Pure: the store applies the result. */
export function planImportColumns(
  mapping: readonly ColumnMapping[],
  existing: ReadonlyArray<{ key: string; name: string; type: string }>,
  options: { canReuseSeedColumn: boolean },
): ImportPlan {
  const canReuseSeed = options.canReuseSeedColumn && isInitialSeedColumn(existing);
  const taken = new Set(existing.map((c) => c.key));
  const names = existing.map((c) => c.name);
  const targets = new Map<number, string>();
  const types = new Map<string, string>(existing.map((c) => [c.key, c.type]));
  for (const m of mapping) if (m.action === "map") targets.set(m.headerIndex, m.columnKey);

  const seedMapped = canReuseSeed && mapping.some((m) => m.action === "map" && m.columnKey === existing[0]?.key);
  const reuse = canReuseSeed && !seedMapped ? mapping.find((m): m is Extract<ColumnMapping, { action: "create" }> => m.action === "create") : undefined;

  const newColumns: PlannedColumn[] = [];
  if (reuse) {
    const seed = existing[0];
    const name = reuse.name.trim() || seed.name;
    names.splice(0, names.length, name);
    // The seed is an empty placeholder, so it takes the key its header would get instead of keeping "name".
    taken.delete(seed.key);
    const key = uniqueColumnKey(name, taken);
    taken.add(key);
    newColumns.push({ key, name, type: reuse.type, reuseExisting: true, replacesKey: seed.key });
    targets.set(reuse.headerIndex, key);
    types.delete(seed.key);
    types.set(key, reuse.type);
  }
  for (const m of mapping) {
    if (m.action !== "create" || m === reuse) continue;
    const key = uniqueColumnKey(m.name, taken);
    taken.add(key);
    const name = uniqueColumnName(m.name.trim() || key, names);
    names.push(name);
    newColumns.push({ key, name, type: m.type, reuseExisting: false });
    targets.set(m.headerIndex, key);
    types.set(key, m.type);
  }
  return { newColumns, targets, types };
}

/** Builds one row's cells from a parsed file row. Blank cells are left out. */
export function buildImportRecords(rows: ReadonlyArray<readonly string[]>, plan: ImportPlan): Array<Record<string, unknown>> {
  const records: Array<Record<string, unknown>> = [];
  for (const row of rows) {
    const cells: Record<string, unknown> = {};
    for (const [headerIndex, key] of plan.targets) {
      const raw = cleanString(restoreFormula((row[headerIndex] ?? "").trim())).slice(0, MAX_CELL_CHARS);
      if (isBlankValue(raw)) continue;
      const type = plan.types.get(key) ?? "text";
      const value = isStaticColumnType(type) ? coerceText(raw, type) : raw;
      if (value !== null) cells[key] = cleanJson(value);
    }
    if (Object.keys(cells).length > 0) records.push(cells);
  }
  return records;
}
