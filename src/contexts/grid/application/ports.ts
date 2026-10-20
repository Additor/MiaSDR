import type { ColumnType, StaticColumnType } from "../domain/column-types";
import type { FormulaLookupRegistry, LookupCall } from "../domain/formula";
import type { GridQuery, TableView } from "../domain/view-query";
import type { CampaignFieldMapping } from "../domain/campaign-rows";
import type { PlannedColumn } from "../domain/import-plan";

export interface FolderRecord {
  id: string;
  name: string;
  parentId: string | null;
  createdAt: Date;
  updatedAt: Date;
}
export interface FolderSummary extends FolderRecord {
  /** Direct children only. */
  folderCount: number;
  workbookCount: number;
}
export interface WorkbookRecord {
  id: string;
  folderId: string | null;
  name: string;
  description: string | null;
  createdAt: Date;
  updatedAt: Date;
}
export interface WorkbookSummary extends WorkbookRecord {
  tableCount: number;
  rowCount: number;
}
export interface TableRecord {
  id: string;
  workbookId: string;
  name: string;
  description: string | null;
  autoRun: boolean;
  position: number;
  view: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}
export interface ColumnRecord {
  id: string;
  tableId: string;
  key: string;
  name: string;
  type: ColumnType;
  config: Record<string, unknown>;
  dependsOn: string[];
  position: number;
  autoRun: boolean;
  createdAt: Date;
  updatedAt: Date;
}
export interface RowRecord {
  id: string;
  tableId: string;
  position: number;
  cells: Record<string, unknown>;
  cellMeta: Record<string, unknown>;
  /** From a global sequence, bumped by a trigger on every write to cells or cell_meta. */
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

/** Folders, workbooks and tables. Every method filters by organization; another tenant's id reads as missing. */
export interface StructureStore {
  listFolders(organizationId: string, parentId: string | null): Promise<FolderSummary[]>;
  listAllFolders(organizationId: string): Promise<FolderRecord[]>;
  getFolder(organizationId: string, id: string): Promise<FolderRecord | null>;
  /** Root-first trail including the folder itself. Empty for an unknown id. */
  folderPath(organizationId: string, id: string): Promise<Array<{ id: string; name: string }>>;
  /** Throws NotFoundError when the parent is not the organization's. */
  createFolder(organizationId: string, input: { name: string; parentId: string | null }): Promise<FolderRecord>;
  /** Throws ValidationError for a move into the folder's own subtree. Null for an unknown id. */
  updateFolder(organizationId: string, id: string, patch: { name?: string; parentId?: string | null }): Promise<FolderRecord | null>;
  /** Deletes the folder and its subfolders. Workbooks inside go to the root. */
  deleteFolder(organizationId: string, id: string): Promise<{ deleted: boolean; released: number }>;

  /** `"all"` lists every workbook, `null` lists the root. */
  listWorkbooks(organizationId: string, folder: string | null | "all"): Promise<WorkbookSummary[]>;
  getWorkbook(organizationId: string, id: string): Promise<WorkbookRecord | null>;
  /** A new workbook opens with one table, one column and one row, so the grid is never an empty dead end. */
  createWorkbook(organizationId: string, input: { name: string; firstTableName: string; folderId: string | null }): Promise<{ workbook: WorkbookRecord; table: TableRecord }>;
  /** Throws NotFoundError when the destination folder is not the organization's. Null for an unknown id. */
  updateWorkbook(organizationId: string, id: string, patch: { name?: string; description?: string | null; folderId?: string | null }): Promise<WorkbookRecord | null>;
  deleteWorkbook(organizationId: string, id: string): Promise<boolean>;

  listTables(organizationId: string, workbookId: string): Promise<TableRecord[]>;
  getTable(organizationId: string, id: string): Promise<TableRecord | null>;
  /** Throws ConflictError past the per-workbook limit. */
  createTable(organizationId: string, input: { workbookId: string; name?: string; description?: string | null; maxTables: number }): Promise<TableRecord>;
  updateTable(organizationId: string, id: string, patch: { name?: string; description?: string | null; autoRun?: boolean; view?: TableView }): Promise<TableRecord | null>;
  /** The member's own sort, filter and hidden columns for a table. Null when they have none. */
  getUserView(organizationId: string, tableId: string, userId: string): Promise<TableView | null>;
  /** Replaces the member's row. Throws NotFoundError for a table that is not the organization's. */
  saveUserView(organizationId: string, tableId: string, userId: string, view: TableView): Promise<void>;
  deleteUserView(organizationId: string, tableId: string, userId: string): Promise<void>;
  /** Appends the table to another workbook. Throws ConflictError when the source would be left empty. */
  moveTable(organizationId: string, id: string, destinationWorkbookId: string, maxTables: number): Promise<TableRecord | null>;
  /** Copies columns, rows and cell metadata next to the original. Queued jobs and run history stay behind. */
  duplicateTable(organizationId: string, id: string, maxTables: number): Promise<TableRecord | null>;
  /** Throws ValidationError when the ids are not exactly the workbook's tables. */
  reorderTables(organizationId: string, workbookId: string, orderedIds: string[]): Promise<TableRecord[]>;
  /** Throws ConflictError for the last table of a workbook. False for an unknown id. */
  deleteTable(organizationId: string, id: string): Promise<boolean>;
  /** Percent of rows with a non-empty value, per column key. */
  columnCoverage(organizationId: string, tableId: string, keys: string[]): Promise<Record<string, number>>;
}

export interface ColumnInsert {
  key: string;
  name: string;
  type: ColumnType;
  config: Record<string, unknown>;
  dependsOn: string[];
  position: number;
  autoRun: boolean;
  /** Key of a column whose cell values are copied into the new one. */
  copyValuesFrom?: string;
  /** Siblings to move so `position` fits (see `placeAfter`). The store applies them under the same table lock. */
  renumber?: ColumnRenumber[];
}

export interface ColumnRenumber {
  id: string;
  position: number;
}

export interface ColumnUpdate {
  name?: string;
  type?: ColumnType;
  config?: Record<string, unknown>;
  dependsOn?: string[];
  position?: number;
  autoRun?: boolean;
  /** Re-coerce every stored value for this static type. */
  convertValues?: (value: unknown) => unknown;
  /** The column stopped being a runner column: drop its queued jobs. */
  dropJobs?: boolean;
  /** Siblings to move so `position` fits. Applied under the same table lock, before the column itself. */
  renumber?: ColumnRenumber[];
}

export interface ColumnDeletePlan {
  deleteIds: string[];
  /** Config rewrites for columns that listed a deleted column as an output. */
  configUpdates: Array<{ id: string; config: Record<string, unknown>; dependsOn?: string[] }>;
  view: TableView;
}

/** Column writes run in one transaction that locks the table row, so two inserts cannot pick the same key or position. */
export interface ColumnStore {
  list(organizationId: string, tableId: string): Promise<ColumnRecord[]>;
  /** `plan` sees the current columns and returns what to insert. It may throw. Null for an unknown table. */
  create(organizationId: string, tableId: string, plan: (existing: ColumnRecord[]) => ColumnInsert): Promise<ColumnRecord | null>;
  /** Null for an unknown column. */
  update(organizationId: string, tableId: string, columnId: string, plan: (current: ColumnRecord, siblings: ColumnRecord[]) => ColumnUpdate): Promise<ColumnRecord | null>;
  /** Removes the columns, their values and queued jobs from every row. Null for an unknown column. */
  remove(
    organizationId: string,
    tableId: string,
    columnId: string,
    plan: (column: ColumnRecord, siblings: ColumnRecord[], view: TableView) => ColumnDeletePlan,
  ): Promise<{ deletedIds: string[] } | null>;
  /** Text to columns, in one transaction. */
  splitText(
    organizationId: string,
    tableId: string,
    columnId: string,
    plan: (source: ColumnRecord, siblings: ColumnRecord[], rows: Array<{ id: string; cells: Record<string, unknown> }>) => { columns: ColumnInsert[]; patches: Array<{ rowId: string; patch: Record<string, unknown> }> },
  ): Promise<{ columns: ColumnRecord[]; rowsUpdated: number } | null>;
}

export interface ColumnRef {
  key: string;
  type: string;
}

export interface CellEdit {
  rowId: string;
  /** Column key to the new value. */
  set: Record<string, unknown>;
  /** Column key to its new cell metadata. Null removes the entry. */
  meta?: Record<string, Record<string, unknown> | null>;
  /** The row version the client saw. Omitted means last write wins. */
  expectedVersion?: number;
  /**
   * Compare-and-set per cell: column key to the value the caller believes is stored. Under the row lock a cell
   * whose stored value differs is left alone and reported in `skipped`; the other cells of the edit still apply.
   */
  expected?: Record<string, unknown>;
}

/** A cell an edit did not write because its stored value differed from `expected` (or its row is gone). */
export interface SkippedCell {
  rowId: string;
  columnKey: string;
  /** The value stored now. Null for an empty cell or a deleted row. */
  current: unknown;
}

export interface CellEditResult {
  rows: RowRecord[];
  /** Value before the edit, per row and key. */
  previous: Map<string, Record<string, unknown>>;
  /** Cells left unwritten by a failed `expected` check. */
  skipped: SkippedCell[];
}

export interface ImportWrite {
  newColumns: PlannedColumn[];
  records: Array<Record<string, unknown>>;
}

/** One pasted block, anchored at a row. See `RowStore.paste`. */
export interface PasteRequest {
  anchorRowId: string;
  /** Rows of the block. The anchor and the rows after it in table order take the first rows; missing rows are created. */
  height: number;
  /** Existing columns the block lands on, from the anchor's column to the right. */
  columnKeys: string[];
  /** Text columns to create after the last of `columnKeys`. */
  newColumns: number;
  limits: { maxRows: number; maxColumns: number; maxNewRows: number };
}

export interface PasteWrite {
  /** `rowIndex` counts from the anchor: 0 is the anchor, `height - 1` the last row of the block. */
  cells: Array<{ rowIndex: number; columnKey: string; value: unknown }>;
}

export interface PasteResult {
  /** Row ids by `rowIndex`, existing rows first and created rows after them. */
  rowIds: string[];
  /** Cells before the write, per row. Created rows are empty. */
  previous: Map<string, Record<string, unknown>>;
  addedRows: number;
  createdColumns: ColumnRecord[];
  rows: RowRecord[];
}

export interface RowStore {
  list(organizationId: string, tableId: string, input: { limit: number; offset: number; query?: GridQuery; columns: ColumnRef[] }): Promise<RowRecord[]>;
  listByIds(organizationId: string, tableId: string, ids: string[]): Promise<RowRecord[]>;
  /** How many of the ids are rows of this table. */
  countByIds(organizationId: string, tableId: string, ids: string[]): Promise<number>;
  /** Ids in view order, at most `limit`. */
  listIds(organizationId: string, tableId: string, input: { query?: GridQuery; columns: ColumnRef[]; limit: number }): Promise<string[]>;
  count(organizationId: string, tableId: string, input?: { query?: GridQuery; columns: ColumnRef[] }): Promise<number>;
  currentVersion(organizationId: string, tableId: string): Promise<number>;
  /** Jobs still queued, running or waiting for the table's cells. A client polls while this is above zero. */
  activeJobs(organizationId: string, tableId: string): Promise<number>;
  /** Rows written after `cursor`, plus a short overlap behind it for transactions that committed late. */
  /** The cursor to start polling from. Read it before the rows it describes. */
  currentCursor(organizationId: string, tableId: string): Promise<string>;
  /**
   * Rows written after `cursor`, in version order, at most `limit`. With `hasMore` the round is not
   * finished: send the returned cursor again right away. The cursor is opaque (see domain/change-cursor.ts)
   * and settles only on the last page, so a row from a late-committing transaction is never skipped.
   * Throws ValidationError for a cursor it cannot read.
   */
  changesSince(organizationId: string, tableId: string, cursor: string, limit: number): Promise<{ rows: RowRecord[]; cursor: string; hasMore: boolean; total: number; activeJobs: number }>;
  /**
   * Marks the cells of these columns as stale (value kept, metadata `{ status: "stale", error: reason }`) in every row
   * that is not stale already (or only in `rowIds` when given), so a repeated call writes nothing. Returns how many rows changed.
   */
  markStale(organizationId: string, tableId: string, columnKeys: string[], reason: string, rowIds?: string[]): Promise<number>;
  /** Throws ConflictError past `maxRows`. */
  addBlank(organizationId: string, tableId: string, count: number, maxRows: number): Promise<RowRecord[]>;
  /**
   * Locks the rows, checks versions, writes. Throws RowConflictError (nothing written) when an
   * expectedVersion is stale, and NotFoundError when a row is not in this table.
   */
  applyEdits(organizationId: string, tableId: string, edits: CellEdit[]): Promise<CellEditResult>;
  delete(organizationId: string, tableId: string, ids: string[]): Promise<number>;
  /**
   * One transaction: lock the table, find the rows from the anchor on in table order, create the missing rows and
   * the new columns (placed with `placeAfter`, siblings renumbered under the lock), ask `build` what to write given
   * all columns, and write. Any failure leaves nothing behind. Null for an unknown table. NotFoundError when the
   * anchor row is gone; ConflictError past the row or column limit or when a target column was removed.
   */
  paste(organizationId: string, tableId: string, request: PasteRequest, build: (current: { columns: ColumnRecord[]; created: ColumnRecord[]; foundRows: number }) => PasteWrite): Promise<PasteResult | null>;
  /**
   * One transaction: lock the table, ask `build` what to write given the current columns, create
   * columns, insert rows and drop the placeholder row. Throws ConflictError past `maxRows` or the column limit.
   */
  importRecords(
    organizationId: string,
    tableId: string,
    build: (current: { columns: ColumnRecord[]; canReuseSeed: boolean }) => ImportWrite,
    limits: { maxRows: number; maxColumns: number },
  ): Promise<{ rowsInserted: number; columnsCreated: number } | null>;
  /**
   * Rows in batches, so an export never loads a whole table. Table order by default; with a `query` the rows
   * match its filters and search in its sort order, the same order `list` gives.
   */
  scan(organizationId: string, tableId: string, input: { batch: number; query?: GridQuery; columns?: ColumnRef[] }): AsyncIterable<RowRecord[]>;
  /** Removes `ids`, locking the rows first. Used by dedupe, which decides the ids from a locked read. */
  deleteDuplicates(organizationId: string, tableId: string, columnId: string, pick: (rows: Array<{ id: string; cells: Record<string, unknown> }>, column: ColumnRecord) => string[]): Promise<number | null>;
}

export interface FormulaStore {
  /**
   * Resolves each LOOKUP table and column (by id, key or name, within the table's workbook) and loads the values.
   * A name that is unknown or ambiguous, or a source table over the row limit, becomes a `LookupFailure` entry
   * for that call, so evaluating it fails with a reason. Throws NotFoundError when `tableId` is not the organization's.
   */
  lookupRegistry(organizationId: string, tableId: string, calls: LookupCall[]): Promise<FormulaLookupRegistry>;
  /** Formula columns of every table in the workbook, for finding the ones that read a LOOKUP source. */
  formulaColumns(organizationId: string, workbookId: string): Promise<ColumnRecord[]>;
  /** First row in table order, or the given row, with its 1-based display number. Null when missing. */
  previewRow(organizationId: string, tableId: string, rowId?: string): Promise<{ row: RowRecord; rowNumber: number } | null>;
  /** IANA zone of the organization, which decides what day TODAY returns. "UTC" when none is stored. */
  organizationTimeZone(organizationId: string): Promise<string>;
}

export interface CellRunStore {
  /** Latest recorded run of the column that produced a cell. */
  latestRun(organizationId: string, tableId: string, rowId: string, sourceColumnKey: string): Promise<{
    id: string;
    provider: string | null;
    outcome: string;
    costCents: number;
    latencyMs: number | null;
    request: unknown;
    response: unknown;
    createdAt: Date;
  } | null>;
}

export interface HandoffTarget {
  campaignId?: string;
  /** Creates a draft email campaign with this name. */
  newCampaignName?: string;
}

export interface HandoffFailure {
  rowId: string;
  reason: string;
}

export interface HandoffReport {
  campaignId: string;
  channel: "email" | "linkedin";
  created: boolean;
  /** Rows that became new enrollments. */
  enrolled: number;
  /** Rows whose lead was created or updated by the import. */
  leadsCreated: number;
  leadsUpdated: number;
  failures: HandoffFailure[];
}

/** Pushes grid rows to a campaign through the leads and outreach contexts. */
export interface CampaignHandoff {
  push(input: {
    organizationId: string;
    userId: string;
    tableId: string;
    tableName: string;
    target: HandoffTarget;
    fields: CampaignFieldMapping;
    customColumnKeys: string[];
    rows: Array<{ id: string; cells: Record<string, unknown> }>;
    columns: Array<{ key: string; name: string }>;
  }): Promise<HandoffReport>;
}

/** Turns a plain-English request into a formula. Null means no AI is configured for the organization. */
export interface FormulaAuthor {
  forOrganization(organizationId: string): Promise<{
    complete(input: { schema: unknown; request: string; currentExpression?: string; feedback?: string }): Promise<{ formula: string; explanation: string }>;
  } | null>;
}

export interface GridDeps {
  structure: StructureStore;
  columns: ColumnStore;
  rows: RowStore;
  formulas: FormulaStore;
  cellRuns: CellRunStore;
  handoff: CampaignHandoff;
  formulaAuthor: FormulaAuthor;
}

export type { StaticColumnType };
