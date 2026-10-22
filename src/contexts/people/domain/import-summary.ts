import { customColumnKey } from "./custom-fields";
import type { BuildResult, CoreTarget, ExistingPerson, ImportPlan, Mapping, RowIssue } from "./import-plan";

/** Rows shown per skip kind before the import. */
export const SUMMARY_EXAMPLES = 3;

/** Rows listed per kind (skipped, conflict, merged duplicate, note) on the result screen after the import. */
export const RESULT_EXAMPLES = 20;

export type SkipKind = "invalid_email" | "missing_identifier" | "file_conflict" | "conflict";

export interface SkipGroup {
  kind: SkipKind;
  count: number;
  /** The first rows of this kind, at most SUMMARY_EXAMPLES. */
  examples: RowIssue[];
}

export interface OverwriteColumn {
  /** The column header in the file. "Source data" stands for every column kept as source data. */
  header: string;
  /** Leads whose stored value in this column the file would replace. */
  leads: number;
}

export interface ImportSummary {
  totalRows: number;
  /** Leads the import would add. */
  created: number;
  /** Existing leads the import would change. */
  updated: number;
  /** Existing leads that already hold every value in the file. */
  unchanged: number;
  /** Rows the import leaves out, grouped by cause. Only kinds with rows appear. */
  skipped: SkipGroup[];
  /** Rows merged into an earlier row of the same file. */
  duplicates: { count: number; examples: RowIssue[] };
  /** Values the importer cannot read and drops while it still imports the row (bad phone, bad email beside a LinkedIn profile). */
  ignored: { count: number; examples: RowIssue[] };
  /** Mapped columns whose values replace stored ones, with how many leads each touches. */
  overwrites: OverwriteColumn[];
}

export const SOURCE_DATA_HEADER = "Source data";

const filled = (value: unknown) => value !== null && value !== undefined && value !== "";

/** The header that carries each core target. Only the first header per target counts, as the mapping allows one. */
function headersByTarget(mapping: Mapping): Map<string, string> {
  const out = new Map<string, string>();
  for (const [header, target] of Object.entries(mapping)) {
    if (target !== "skip" && !out.has(target)) out.set(target, header);
  }
  return out;
}

/** The header behind each custom column, keyed by the key the column is stored under. */
function customHeaders(mapping: Mapping, keyMap: ReadonlyMap<string, string>): Map<string, string> {
  const out = new Map<string, string>();
  for (const [header, target] of Object.entries(mapping)) {
    if (!target.startsWith("custom:")) continue;
    const requested = customColumnKey(target.slice("custom:".length).trim());
    if (requested) out.set(keyMap.get(requested) ?? requested, header);
  }
  return out;
}

const SCALAR_TARGETS: Array<[keyof ExistingPerson & ("firstName" | "lastName" | "fullName" | "title" | "phone"), CoreTarget]> = [
  ["firstName", "first_name"],
  ["lastName", "last_name"],
  ["fullName", "full_name"],
  ["title", "title"],
  ["phone", "phone"],
];

/**
 * Counts, per mapped column, the existing leads whose stored value the plan replaces. A value that fills an
 * empty field is not an overwrite. Reads the plan the real import applies, so both agree.
 */
export function overwriteColumns(plan: ImportPlan, existing: ExistingPerson[], mapping: Mapping, keyMap: ReadonlyMap<string, string>): OverwriteColumn[] {
  const byId = new Map(existing.map((p) => [p.id, p]));
  const byTarget = headersByTarget(mapping);
  const byCustomKey = customHeaders(mapping, keyMap);
  const counts = new Map<string, number>();
  // Two rows of the file can point at one stored lead (one by email, one by LinkedIn). That lead counts once per column.
  const seen = new Set<string>();
  let current = "";
  const bump = (header: string | undefined) => {
    if (!header || seen.has(`${current}\0${header}`)) return;
    seen.add(`${current}\0${header}`);
    counts.set(header, (counts.get(header) ?? 0) + 1);
  };

  for (const update of plan.updates) {
    const person = byId.get(update.id);
    if (!person) continue;
    const { patch } = update;
    current = person.id;
    for (const [field, target] of SCALAR_TARGETS) {
      if (patch[field] !== undefined && filled(person[field])) bump(byTarget.get(target));
    }
    if (patch.linkedinUrl && filled(person.linkedinUrl)) bump(byTarget.get("linkedin"));
    if (patch.companyDomain && filled(person.companyDomain)) bump(byTarget.get("company_domain"));
    for (const key of Object.keys(patch.custom ?? {})) {
      if (filled(person.custom[key])) bump(byCustomKey.get(key));
    }
    if (patch.raw && person.raw && Object.entries(person.raw).some(([key, value]) => filled(value) && patch.raw?.[key] !== value)) {
      bump(SOURCE_DATA_HEADER);
    }
  }
  return [...counts].map(([header, leads]) => ({ header, leads })).sort((a, b) => b.leads - a.leads || a.header.localeCompare(b.header));
}

/** Builds what the wizard shows before the import: the plan's counts, the skipped rows and the overwrites. */
export function buildImportSummary(input: {
  totalRows: number;
  built: BuildResult;
  plan: ImportPlan;
  existing: ExistingPerson[];
  mapping: Mapping;
  keyMap: ReadonlyMap<string, string>;
}): ImportSummary {
  const { built, plan } = input;
  const group = (kind: SkipKind, issues: RowIssue[]): SkipGroup => ({ kind, count: issues.length, examples: issues.slice(0, SUMMARY_EXAMPLES) });
  const skipped = [
    group("invalid_email", built.invalid.filter((i) => i.kind === "invalid_email")),
    group("missing_identifier", built.invalid.filter((i) => i.kind === "missing_identifier")),
    group("file_conflict", built.invalid.filter((i) => i.kind === "file_conflict")),
    group("conflict", plan.conflicts),
  ].filter((g) => g.count > 0);

  // A skipped row imports nothing, so a value it could not read is no news.
  const skippedRows = new Set(built.invalid.map((i) => i.row));
  const ignored = built.warnings.filter((w) => !skippedRows.has(w.row));

  return {
    totalRows: input.totalRows,
    created: plan.inserts.length,
    updated: plan.updates.length,
    unchanged: plan.unchanged,
    skipped,
    duplicates: { count: built.duplicatesInFile, examples: built.duplicateRows.slice(0, SUMMARY_EXAMPLES) },
    ignored: { count: ignored.length, examples: ignored.slice(0, SUMMARY_EXAMPLES) },
    overwrites: overwriteColumns(plan, input.existing, input.mapping, input.keyMap),
  };
}

/** True when the import would add or change at least one lead. */
export function summaryChangesAnything(summary: Pick<ImportSummary, "created" | "updated">): boolean {
  return summary.created + summary.updated > 0;
}

/** "Import 120 leads: 100 new, 18 updated". The wizard puts this on the confirm button. */
export function confirmLabel(summary: Pick<ImportSummary, "created" | "updated">): string {
  const total = summary.created + summary.updated;
  if (total === 0) return "Nothing to import";
  const parts = [summary.created > 0 && `${summary.created.toLocaleString("en-US")} new`, summary.updated > 0 && `${summary.updated.toLocaleString("en-US")} updated`].filter(Boolean);
  return `Import ${total.toLocaleString("en-US")} ${total === 1 ? "lead" : "leads"}: ${parts.join(", ")}`;
}

/** Up to `limit` distinct non-empty values per header, in file order, each cut to `maxLength` characters. */
export function collectExamples(headers: string[], rows: Array<Record<string, string>>, limit = 3, maxLength = 80): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  const open = new Set(headers);
  for (const header of headers) out[header] = [];
  for (const row of rows) {
    if (open.size === 0) break;
    for (const header of open) {
      const value = (row[header] ?? "").trim();
      if (!value) continue;
      const shown = value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value;
      if (out[header].includes(shown)) continue;
      out[header].push(shown);
      if (out[header].length >= limit) open.delete(header);
    }
  }
  return out;
}

/** The importer's sample file: headers it maps without help and two made-up leads. */
export const SAMPLE_CSV_HEADERS = ["Email", "First name", "Last name", "Job title", "Phone", "LinkedIn URL", "Company", "Company domain"] as const;

const SAMPLE_CSV_ROWS: string[][] = [
  ["ada@example.com", "Ada", "Lovelace", "Head of Engineering", "+1 415 555 0100", "https://www.linkedin.com/in/ada-lovelace-example", "Analytical Engines", "analytical-engines.example"],
  ["grace@example.com", "Grace", "Hopper", "VP Operations", "+1 415 555 0101", "https://www.linkedin.com/in/grace-hopper-example", "Compiler Works", "compiler-works.example"],
];

/** The sample file as CSV text. The cells hold no comma or quote, and the phone numbers keep their leading plus, so no escaping applies. */
export function sampleImportCsv(): string {
  return `${[[...SAMPLE_CSV_HEADERS], ...SAMPLE_CSV_ROWS].map((row) => row.join(",")).join("\r\n")}\r\n`;
}
