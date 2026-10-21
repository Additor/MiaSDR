import type { ColumnType } from "@/contexts/grid/domain/column-types";
import type { TableView } from "@/contexts/grid/domain/view-query";

/** JSON shapes the grid endpoints return. Dates arrive as ISO strings. */
export interface GridColumn {
  id: string;
  tableId: string;
  key: string;
  name: string;
  type: ColumnType;
  config: Record<string, unknown>;
  dependsOn: string[];
  position: number;
  autoRun: boolean;
}

export interface CellMeta {
  status?: string;
  outcome?: string;
  provider?: string;
  error?: string;
  /** Why a cell was not run, for `skipped: cap`. */
  reason?: string;
  costCents?: number;
  /** Vendor credits the cell used across its steps, when its providers count credits. */
  credits?: number;
  /** On a miss: the steps that never answered, as "provider: why". */
  unanswered?: string[];
  /** When a waiting cell runs again (ISO time). */
  runAfter?: string;
  runAt?: string;
}

export interface GridRow {
  id: string;
  position: number;
  cells: Record<string, unknown>;
  cellMeta: Record<string, CellMeta | undefined>;
  /** From a global sequence. Sent back as `expectedVersion` on an edit. */
  version: number;
}

export interface GridTable {
  id: string;
  workbookId: string;
  name: string;
  description: string | null;
  autoRun: boolean;
  position: number;
  view: TableView;
}

export interface TablePage {
  table: GridTable;
  columns: GridColumn[];
  rows: GridRow[];
  total: number;
  unfilteredTotal: number;
  /** Opaque. Send it back to the changes feed unchanged. */
  cursor: string;
  coverage: Record<string, number>;
  activeJobs: number;
  /** What this member sees: the table's default with their own sort, filter and hidden columns on top. */
  view: TableView;
  defaultView?: TableView;
  /** True when this member has stored a view of their own. */
  personalView?: boolean;
  /** Owners and admins can save the default for everyone. */
  canEditDefault?: boolean;
}

export interface ChangesPage {
  rows: GridRow[];
  cursor: string;
  /** True while the feed has more rows to give. Ask again at once with the new cursor. */
  hasMore: boolean;
  total: number;
  activeJobs: number;
}

export interface JobCounts {
  queued: number;
  running: number;
  waiting: number;
  succeeded: number;
  failed: number;
}

export interface CellEditInput {
  rowId: string;
  columnKey: string;
  value: unknown;
}

export interface RowConflict {
  rowId: string;
  expectedVersion: number;
  currentVersion: number | null;
  cells: Record<string, unknown> | null;
}

export interface FolderSummary {
  id: string;
  name: string;
  parentId: string | null;
  folderCount: number;
  workbookCount: number;
}

export interface WorkbookSummary {
  id: string;
  folderId: string | null;
  name: string;
  description: string | null;
  updatedAt: string;
  tableCount: number;
  rowCount: number;
}
