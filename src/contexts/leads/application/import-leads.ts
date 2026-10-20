import type { DbHandle } from "@/platform/db/client";
import { buildImportSummary, RESULT_EXAMPLES, type ImportSummary } from "../domain/import-summary";
import {
  buildCandidates,
  type BuildResult,
  planImport,
  remapCustomKeys,
  validateMapping,
  type CustomColumnRequest,
  type ExistingPerson,
  type ImportPlan,
  type Mapping,
  type RowIssue,
} from "../domain/import-plan";

export const MAX_IMPORT_ROWS = 10_000;

export type ImportStats = {
  totalRows: number;
  created: number;
  updated: number;
  unchanged: number;
  invalid: number;
  duplicatesInFile: number;
  conflicts: number;
  companiesCreated: number;
  /** Rows whose source data lost a column or part of a value to the size caps. */
  rawTruncatedRows: number;
};

export interface ImportReport {
  runId: string;
  stats: ImportStats;
  /** First issues of each kind, capped, for the result screen. */
  issues: { invalid: RowIssue[]; conflicts: RowIssue[]; duplicates: RowIssue[]; warnings: RowIssue[] };
}

/** What the import reads by: the file's emails, LinkedIn slugs, member ids and company domains. */
export interface ImportKeys {
  emails: string[];
  slugs: string[];
  /** `raw.linkedin_member_id` values of rows known only by a Sales Navigator or Recruiter member id. */
  memberIds?: string[];
  /** Company domains of the rows, so the store can read which of them are other domains (aliases) of a company. */
  domains?: string[];
}

/** Builds the plan from the existing people, the stored column keys and the alias map (alias domain to the company's domain). */
export type ImportPlanner = (existing: ExistingPerson[], keyMap: ReadonlyMap<string, string>, aliases: ReadonlyMap<string, string>) => ImportPlan;

/** Port. The store runs `plan` inside one transaction that holds a per-organization lock. */
export interface LeadStore {
  applyImport(input: {
    organizationId: string;
    createdBy: string;
    filename: string | null;
    mapping: Mapping;
    keys: ImportKeys;
    customColumns: CustomColumnRequest[];
    restoreArchivedColumns: boolean;
    baseStats: Pick<ImportStats, "totalRows" | "invalid" | "duplicatesInFile" | "rawTruncatedRows">;
    /** `keyMap` maps the key a label derives to the key of the column that holds it (an existing column can have another key). */
    plan: ImportPlanner;
    /** An open transaction of the caller. The import joins it instead of committing on its own. */
    tx?: DbHandle;
  }): Promise<{ runId: string; stats: ImportStats; plan: ImportPlan }>;
  /**
   * Runs the same lookups and the same `plan` as `applyImport`, takes the same lock, and writes nothing:
   * the transaction rolls back after the plan is made. Raises the same errors, such as a refused archived column.
   */
  previewImport(input: {
    organizationId: string;
    keys: ImportKeys;
    customColumns: CustomColumnRequest[];
    restoreArchivedColumns: boolean;
    plan: ImportPlanner;
  }): Promise<ImportPreviewResult>;
}

/** What a dry run returns: the plan the real import would apply and the rows it would read them from. */
export interface ImportPreviewResult {
  plan: ImportPlan;
  existing: ExistingPerson[];
  keyMap: ReadonlyMap<string, string>;
}

export { remapCustomKeys };

export class ImportInputError extends Error {}


export interface ImportCommand {
  organizationId: string;
  userId: string;
  filename: string | null;
  headers: string[];
  rows: Array<Record<string, string>>;
  mapping: Mapping;
  defaultCountry?: string;
  /** True only for an owner or admin: a header that matches an archived column then restores it. Otherwise the import is refused with a message. */
  restoreArchivedColumns?: boolean;
  /** An open transaction of the caller, so the import commits or rolls back with the caller's other writes. */
  tx?: DbHandle;
}

type Prepared = {
  built: BuildResult;
  keys: Required<ImportKeys>;
  restoreArchivedColumns: boolean;
};

/** Validates the command and reads the rows. The import and its dry run share this, so both see the same candidates. */
async function prepare(deps: { defaultPhoneCountry?: (organizationId: string) => Promise<string | undefined> }, command: ImportCommand): Promise<Prepared> {
  if (command.rows.length === 0) throw new ImportInputError("The file has no data rows.");
  if (command.rows.length > MAX_IMPORT_ROWS) {
    throw new ImportInputError(`The file has ${command.rows.length} rows. The limit is ${MAX_IMPORT_ROWS}; split it and import in parts.`);
  }
  const mappingError = validateMapping(command.headers, command.mapping);
  if (mappingError) throw new ImportInputError(mappingError);

  // A country chosen for this file wins; otherwise the organization's default reads local-format numbers.
  const defaultCountry = command.defaultCountry ?? (await deps.defaultPhoneCountry?.(command.organizationId));
  const built = buildCandidates(command.rows, command.mapping, { defaultCountry, headers: command.headers });
  return {
    built,
    keys: {
      emails: built.candidates.flatMap((c) => (c.email ? [c.email] : [])),
      slugs: built.candidates.flatMap((c) => (c.linkedinSlug ? [c.linkedinSlug] : [])),
      memberIds: built.candidates.flatMap((c) => (c.linkedinMemberId ? [c.linkedinMemberId] : [])),
      domains: [...new Set(built.candidates.flatMap((c) => (c.companyDomain ? [c.companyDomain] : [])))],
    },
    restoreArchivedColumns: command.restoreArchivedColumns === true,
  };
}

export async function importLeads(deps: { store: LeadStore; defaultPhoneCountry?: (organizationId: string) => Promise<string | undefined> }, command: ImportCommand): Promise<ImportReport> {
  const { built, keys, restoreArchivedColumns } = await prepare(deps, command);

  const result = await deps.store.applyImport({
    organizationId: command.organizationId,
    createdBy: command.userId,
    filename: command.filename,
    mapping: command.mapping,
    keys,
    customColumns: built.customColumns,
    restoreArchivedColumns,
    baseStats: {
      totalRows: command.rows.length,
      invalid: built.invalid.length,
      duplicatesInFile: built.duplicatesInFile,
      rawTruncatedRows: built.rawTruncatedRows,
    },
    plan: (existing, keyMap, aliases) => planImport(remapCustomKeys(built.candidates, keyMap), existing, { aliases }),
    tx: command.tx,
  });

  return {
    runId: result.runId,
    stats: result.stats,
    issues: {
      invalid: built.invalid.slice(0, RESULT_EXAMPLES),
      conflicts: result.plan.conflicts.slice(0, RESULT_EXAMPLES),
      duplicates: built.duplicateRows.slice(0, RESULT_EXAMPLES),
      warnings: built.warnings.slice(0, RESULT_EXAMPLES),
    },
  };
}

/**
 * Dry run of `importLeads` for the wizard's last check: the same validation, candidates, lookups and plan,
 * with no writes. The counts it returns equal the report the import returns for the same input.
 */
export async function previewImport(
  deps: { store: LeadStore; defaultPhoneCountry?: (organizationId: string) => Promise<string | undefined> },
  command: Omit<ImportCommand, "userId" | "filename" | "tx">,
): Promise<ImportSummary> {
  const { built, keys, restoreArchivedColumns } = await prepare(deps, command as ImportCommand);
  const { plan, existing, keyMap } = await deps.store.previewImport({
    organizationId: command.organizationId,
    keys,
    customColumns: built.customColumns,
    restoreArchivedColumns,
    // The same alias rewrite as the import, so the preview's numbers equal the import's.
    plan: (found, map, aliases) => planImport(remapCustomKeys(built.candidates, map), found, { aliases }),
  });
  return buildImportSummary({ totalRows: command.rows.length, built, plan, existing, mapping: command.mapping, keyMap });
}
