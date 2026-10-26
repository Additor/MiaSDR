/** Request-size and row-count limits of the grid. One place, so routes and use cases agree. */
export const GRID_LIMITS = {
  /** JSON bodies other than cell edits and imports. */
  jsonBodyBytes: 256 * 1024,
  /** A cell edit batch. */
  cellsBodyBytes: 5 * 1024 * 1024,
  /** CSV upload, matching the leads importer. */
  importFileBytes: 5 * 1024 * 1024,
  /** Rows one import may add. */
  importRows: 10_000,
  importColumns: 200,
  /** Rows one table may hold. */
  tableRows: 50_000,
  columnsPerTable: 200,
  tablesPerWorkbook: 100,
  /** Blank rows one request may add. */
  addRows: 1_000,
  /** New columns one paste may create. */
  pasteNewColumns: 100,
  /** Cell edits in one request, and the rows they may touch. */
  cellUpdates: 5_000,
  cellUpdateRows: 1_000,
  deleteRows: 5_000,
  /** Rows in one table page. */
  pageSize: 1_000,
  defaultPageSize: 200,
  /** Row ids returned by a selection, and rows one export may include. */
  selection: 50_000,
  exportRows: 50_000,
  /** Rows one campaign handoff may push. */
  campaignRows: 5_000,
  formulaChars: 5_000,
  formulaPromptChars: 2_000,
} as const;
