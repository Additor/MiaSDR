# Grid context

Clay-style tables: folder, workbook, table, typed columns, rows. Cells live in `grid_rows.cells` (jsonb keyed by column key), per-cell run state in `cell_meta`. Every table carries `organization_id`; every query filters on it, and another tenant's id answers `NotFoundError`.

Two modules share this context. The enrichment module owns providers, credentials, AI and enrichment columns, `grid_jobs`, `grid_cell_runs` writes and `/run`, and lives in `enrichment/` with its own `domain`, `application` and `infrastructure` folders. The core module (this section) owns everything else. They meet at the functions listed under "Seams".

## Core module

Any member of the organization can use all of it. Nothing here sends anything.

### Application functions

Each takes `deps` (`gridDeps()` from `infrastructure/composition.ts`) and an `Actor`. Inputs typed `unknown` are validated inside and throw `ValidationError` (HTTP 422).

`application/structure-management.ts`
- `listFolders(deps, actor, parentId?: string | null)` all folders when `parentId` is undefined, the root when null
- `getFolder(deps, actor, id)` returns `{ folder, folders, workbooks, path }`
- `createFolder(deps, actor, { name?, parentId? })`, `updateFolder(deps, actor, id, { name?, parentId? })`, `deleteFolder(deps, actor, id)` (subfolders go, workbooks move to the root)
- `listWorkbooks(deps, actor, folder: string | null | "all")`, `getWorkbook`, `createWorkbook(deps, actor, { name?, firstTableName?, folderId? })`, `updateWorkbook`, `deleteWorkbook`
- `listTables(deps, actor, workbookId)`, `createTable(deps, actor, { workbookId, name?, description? })`
- `updateTable(deps, actor, tableId, { name?, description?, autoRun?, view?, workbookId? })` (`workbookId` moves the table first; `view` is the shared default and needs an owner or admin, otherwise `ForbiddenError`)
- `saveMyView(deps, actor, tableId, view)` stores the member's own sort, filter, hidden columns and pinned columns (only the keys that differ from the default; pins are a personal setting, at most 3, each an existing column) in `grid_user_views`; `resetMyView(deps, actor, tableId)` drops them; `resolveView` merges the two layers. Routes `PUT` and `DELETE /api/grid/tables/[tableId]/view`
- `duplicateTable`, `reorderTables(deps, actor, workbookId, tableIds)`, `deleteTable` (the last table of a workbook is protected)

`application/column-management.ts`
- `listColumns(deps, actor, tableId)`
- `createColumn(deps, actor, tableId, { name, type, config?, autoRun?, afterColumnId?, beforeColumnId?, copyValuesFrom? })`
- `updateColumn(deps, actor, tableId, columnId, { name?, type?, config?, autoRun?, afterColumnId? })` (a static to static type change converts stored values)
- `deleteColumn(deps, actor, tableId, columnId, { withOutputs? })` (strips the key from every row and drops the column's queued jobs)
- `dedupeColumn(deps, actor, tableId, columnId)`, `textToColumns(deps, actor, tableId, columnId, delimiter)`
- `registerColumnTypeHook(type, { validate?, dependsOn? })`: see "Seams"

`application/row-management.ts`
- `getTablePage(deps, actor, tableId, { limit?, offset?, search?, coverage? })` returns `{ table, columns, rows, total, unfilteredTotal, cursor, coverage, activeJobs, view, defaultView, personalView, canEditDefault }` (`view` is the member's merged view). `coverage` is the fill rate per column in percent, computed for the first page only; `coverage: false` (route `?coverage=0`) skips the full scan, as the search box does
- `listRows`, `addRows(deps, actor, tableId, count)`, `deleteRows(deps, actor, tableId, rowIds)`
- `selectRows(deps, actor, tableId, { search? })` returns `{ rowIds, truncated }` for the member's view plus search
- `getChanges(deps, actor, tableId, cursor)` returns `{ rows, cursor, hasMore, total, activeJobs }`. The cursor is an opaque string (`domain/change-cursor.ts`): send back what the table GET or the last call returned, and call again at once while `hasMore` is true. It settles on the last page, so a row from a late-committing transaction is never skipped.
- `editCells(deps, actor, tableId, [{ rowId, columnKey, value, expectedVersion?, expect?: { value } }], { undo? })` returns `{ updatedCells, rows, queued, skippedByCap, applied, skipped }`. `expect` makes a cell a compare-and-set: a cell that holds another value is left alone and listed in `skipped` with its `current` value. `applied` lists each written cell with the coerced value. With `undo` (undo and redo) no paid auto-run starts, the runner columns that read the cells are marked stale, and a cell whose column is gone, is a runner column now or refuses the value is skipped instead of failing the request

`application/paste-management.ts`
- `pasteCells(deps, actor, tableId, { anchorRowId, columnKeys, newColumns?, values, search? })` writes a block of text in one transaction and returns `{ rows, applied, addedRows, createdColumns, skippedRunner, invalid, invalidCount, queued, skippedByCap }`

`application/import-export.ts`
- `previewImport(deps, actor, tableId, sheet, fileName)`, `runImport(deps, actor, tableId, sheet, mapping)` with `sheet = { headers, rows: string[][] }`; `infrastructure/parse-upload.ts` builds a sheet from a CSV or XLSX upload (`parseUpload(file, { sheet })`). For a workbook with several sheets the preview returns `sheets` (names, in order) and `sheet` (the 1-based sheet read); an empty or header-only sheet comes back as a `problem` with the picker data instead of an error
- `exportTableCsv(deps, actor, tableId, { rowIds?, columnKeys?, useView?, search? })` returns `{ filename, rowCount, chunks: AsyncGenerator<string> }`

With `useView` the server resolves the member's merged view and the search, and exports the rows the grid shows, in the grid's order; `rowIds` wins when both are present. The 50,000-row limit counts the filtered rows. A sorted export pages by offset without a snapshot.

`application/formula-management.ts`: `previewFormula(deps, actor, tableId, { expression, rowId? })`, `generateFormula(deps, actor, tableId, { prompt, currentExpression? })`.

`application/cell-details.ts`: `getCellDetails(deps, actor, tableId, rowId, columnKey)` (read only).

`application/campaign-handoff.ts`: `pushToCampaign(deps, actor, tableId, { rowIds, target: { campaignId } | { newCampaignName }, fields, customColumnKeys? })`.

### Domain (pure)

- `domain/formula.ts`: `compileFormula(expression)`, `evaluateFormula(expressionOrCompiled, row, { textKeys?, lookups?, now?, timeZone? })`, `FORMULA_LIMITS`, `lookupSignature`, `lookupValueKey`. The runner for formula columns should call `evaluateFormula` with `textKeys` from `textColumnKeys(columns)` and a lookup registry from `deps.formulas.lookupRegistry`.
- `domain/formula-parser.ts`: the expression grammar and `FormulaError`. `domain/formula-dates.ts`: date helpers for the formula engine; the caller injects the clock and the time zone. `domain/formula-dependencies.ts`: matches a LOOKUP source change to the formula columns that read it, by name token.
- `domain/change-cursor.ts`: the opaque cursor of the changes feed (`formatChangeCursor`, `parseChangeCursor`).
- `domain/cell-compare.ts`: `sameCellValue`, the equality behind `expect` in cell edits (null equals absent, key order ignored).
- `domain/row-conflict.ts`: `RowConflictError`, the 409 for a stale `expectedVersion`, with the current row.
- `domain/column-layout.ts`: `chainPlacement`, positions for a run of new columns after one column, moving siblings when the gap runs out.
- `domain/column-operations.ts`: `splitValue` for text to columns, `duplicateRowIds` for dedupe, `removeColumnFromView`.
- `domain/output-sanitize.ts`: strips control characters and lone surrogates from provider and AI answers and bounds their length.
- `domain/campaign-rows.ts`: turns grid rows into a lead import for the campaign handoff.
- `domain/column-config.ts`, `domain/keys.ts`, `domain/column-types.ts`, `domain/cell-values.ts`, `domain/view-query.ts`, `domain/import-plan.ts`, `domain/csv.ts`.

## Formula language

One expression, no statements. A leading `=` is allowed.

- Cells: `{{columnKey}}`. A blank text column reads as `""`, any other blank as `null`.
- Literals: numbers, `"text"` or `'text'`, `true`, `false`, `null`, lists `[1, 2]`.
- Operators: `+ - * / % ^`, `&` (join text), `== = != <> < > <= >=`, `&& || !`, `a ? b : c`. `+` joins when either side is text.
- Functions: IF AND OR NOT IFERROR COALESCE ISBLANK ISNUMBER ISTEXT CONCATENATE TEXTJOIN JOIN UPPER LOWER PROPER TRIM LEN LEFT RIGHT MID SUBSTITUTE FIND CONTAINS STARTSWITH ENDSWITH SPLIT REPEAT DOMAIN TEXT NUMBER ABS ROUND FLOOR CEILING INT MOD POWER SQRT SUM AVERAGE MIN MAX COUNT SEQUENCE LOOKUP.
- `LOOKUP("Table", value, "Lookup column", "Return column", default?)` reads another table of the same workbook. Table and column names are quoted text, matched by name, key or id.
- There is no property access, no assignment and no way to reach a global: a bare name is an error, a function name resolves through a fixed table. Limits: 5,000 characters, 1,200 tokens, nesting 48, tree height 160, 2,500 nodes, 60,000 evaluation steps, 100,000 characters of text, lists of 10,000, 32 arguments.

## HTTP

All under `/api/grid`, all through `withActor` (401 without a session). JSON bodies are capped at 256 KB (cell edits and campaign pushes at 5 MB), uploads at 5 MB. Errors: 404 unknown or foreign id, 409 conflict or limit, 413 too large, 422 invalid input.

| Path | Methods |
|---|---|
| `folders`, `folders/[folderId]` | GET POST, GET PATCH DELETE |
| `workbooks`, `workbooks/[workbookId]`, `workbooks/[workbookId]/tables/reorder` | GET POST, GET PATCH DELETE, POST |
| `tables`, `tables/[tableId]` | GET POST, GET PATCH DELETE |
| `tables/[tableId]/columns`, `.../columns/[columnId]`, `.../dedupe`, `.../text-to-columns` | GET POST, PATCH DELETE, POST, POST |
| `tables/[tableId]/rows`, `cells`, `paste`, `changes`, `selection` | GET POST DELETE, PATCH, POST, GET, GET |
| `tables/[tableId]/view` | PUT, DELETE (the caller's own view) |
| `tables/[tableId]/import`, `export`, `duplicate` | POST (multipart, optional form field `sheet`), POST (CSV stream; body `rowIds?`, `columnKeys?`, `useView?`, `search?`), POST |
| `tables/[tableId]/formula-preview`, `formula-generate`, `cell-details`, `campaigns` | POST, POST, GET, POST |
| `tables/[tableId]/columns/[columnId]/recalculate` | POST (formula column, every row) |
| `tables/[tableId]/run`, `run/retry` | GET (job counts) POST (queue) DELETE (stop), POST (failed cells only, body `columnKey?`) |
| `tables/[tableId]/cell-runs` | GET (`?rowId=&columnKey=`, the run ledger of one cell) |
| `tables/[tableId]/ai`, `enrichments` | POST PATCH, POST PATCH |
| `providers`, `providers/[id]` | GET POST, PATCH DELETE (POST and PATCH need an owner or admin) |

### Versioned cell edits

Every row has a `version` from one global sequence. A trigger bumps it on any write to `cells` or `cell_meta`, so clients poll `changes?cursor=<version>`.

`PATCH cells` takes `{ rowId, columnKey, value, expectedVersion? }` or `{ updates: [...] }`. With `expectedVersion` (the `version` the client last read) a stale row makes the whole request fail with 409 and `{ error, conflicts: [{ rowId, expectedVersion, currentVersion, cells }] }`. Nothing is written, so a pasted block is all or nothing. Without `expectedVersion` the write wins. The response carries the updated rows with their new versions.

`expected` / `undo`: a cell update may carry `expected` (any JSON value, null for an empty cell). Under the row lock the stored value is compared (null equals absent, deep equality). Equal cells apply; the others are left alone. The response adds `applied: [{ rowId, columnKey, value }]` and `skipped: [{ rowId, columnKey, current }]`. `undo: true` in the body marks a restore (see `editCells`). Cells with `expected` and cells without can share one request.

`paste`: `POST tables/[tableId]/paste` with `{ anchorRowId, columnKeys, newColumns?, values, search? }`; `values` is a rectangle of text (null for empty), one entry per `columnKeys` plus `newColumns`. Limits: 1,000 rows, 5,000 cells, 100 new text columns, all checked before any write. Rows and columns are added only while the table is shown whole in table order: an active filter, a sort or a `search` answers 422. Runner columns are skipped and counted. The route is intentionally a 409 path in the route matrix; the happy path and tenant isolation are covered in `paste-block.integration.test.ts`.

`changes` re-reads rows written in the last 30 seconds within 2,000 versions of the cursor, so a transaction that committed late is not missed. A drop in `total` means rows were deleted: reload the page.

### Import and export

Import takes a CSV or XLSX (5 MB, 10,000 rows, 200 columns). For an .xlsx, the optional form field `sheet` (a whole number from 1, in both calls) picks the sheet; the wizard shows a sheet picker when the workbook has more than one. A workbook index over 1 MB, more than 255 sheets or a sheet name over 255 characters is refused. The first call without `mapping` previews; the second, with the same file and a `mapping`, writes. A table holds at most 50,000 rows.

Export writes UTF-8 with a BOM. Any text cell that starts with `=`, `+`, `-`, `@`, tab or CR (after optional spaces) gets a leading apostrophe. Import removes that apostrophe again, so an exported file reads back unchanged.

### Campaign handoff

`campaigns` maps lead fields (`email`, `linkedin`, `firstName`, `lastName`, `fullName`, `title`, `phone`, `companyName`, `companyDomain`) to column keys and pushes the selected rows through the leads import (`importLeads`: the same validation and de-duplication as a file import). Then it enrolls them. A suppressed address never becomes a lead. Do-not-contact people, people already in the campaign, rows without a valid address and rows that repeat an earlier lead are skipped and listed in `failures` with a reason. The campaign keeps its status, so a draft stays a draft and nothing is sent.

## Seams with the enrichment module

- `application/cell-events.ts`: `registerCellsChangedListener(fn)`. After a cell edit commits, listeners get `{ organizationId, tableId, userId, changes: [{ rowId, columnKey, previous, value }] }` and may return how many cells they queued, or `{ queued, skippedByCap }`. `infrastructure/composition.ts` registers the listener that calls `cascadeFromEdits`, which applies the cascade limits in `domain/enrichment-run-limits.ts` (100 rows per column, 500 cents worst case, 2,000 pending cells per organization) and marks held-back cells `skipped: cap`.
- `registerColumnTypeHook(type, { validate, dependsOn })`: the generic column endpoints refuse to create or retarget a runner column (any type except `formula`) that has no hook, so raw JSON cannot reach the worker unchecked. The enrichment module creates its columns through its own endpoints. Renaming, moving and the auto-run switch still work on every column.
- Formula columns: the grid stores `config.expression` and `depends_on`. Running the column belongs to the runner, which calls `evaluateFormula`.
- `deleteColumn` removes the column's rows of `grid_jobs`. It leaves `grid_cell_runs` to the cascade from the row.

## Runs, AI columns and recalculation

- `POST tables/[tableId]/run` takes `{ columnKey?, rowIds?, onlyEmpty?, maxRows?, maxCostCents?, firstN? }`. `firstN` queues the first N rows in table order after the skip rules (`onlyEmpty`, the input check); a row counts when at least one of its target cells would queue. The scan reads 500 rows per query up to 100,000 rows. `firstN` above `maxRows` is refused. Without `firstN`, `maxRows` refuses a larger run and never truncates. Row ids are de-duplicated before the check. A single cell run posts `{ columnKey: source, rowIds: [rowId], onlyEmpty: false, maxRows: 1 }`.
- AI columns (`POST` and `PATCH tables/[tableId]/ai`) declare output fields of type `text`, `number`, `boolean`, `email`, `url`, `date` or `json`. The model answers email, url, date and json as text. `domain/ai-output-coerce.ts` checks each answer before the write: an email (254 characters, no `..`, no leading `=`, `+`, `-` or `@`, no control characters), an http or https URL with a dotted host (2,048 characters, no whitespace), a real calendar date (an ISO timestamp is cut to its date), a JSON object or array (at most 5,000 characters), text (at most 5,000 characters). A rejected value is stored as that cell's error and the cell keeps its earlier value. The job succeeds, so the paid call is not repeated. "Retry failed" does not pick these cells up; a normal run does.
- `PATCH .../ai` takes the full `outputs` list. A field reuses the column it filled by key, then by column name. A field with no match gets a new `ai_output` column after the last one the AI column fills. A column that holds values cannot be retyped. The prompt is trimmed. `steps` or `inputs` sent to an AI column, and `prompt` sent to an enrichment or waterfall column, answer 422. An `inputs` edit re-checks the required inputs of the column's actions. `PATCH .../enrichments` edits inputs, delay and, for a waterfall, 1 to 8 steps.
- Column writes for runner columns go through `GridRunStore.changeColumns`: one transaction under the table lock. A change that would take the table past 200 columns answers 422.
- Formula recalculation has a time budget of `RECALC_BUDGET_MS` (25 s, a constant in `application/formula-recalc.ts`, not an environment variable) per request. When it stops, or a recalculation fails, the unfinished cells get a stale marker with the reason, and the Recalculate action answers 409. Run it again to continue.
- Pins (`pinnedColumns` in a view) are a personal setting: at most 3, each an existing column. A stored empty list unpins the default for that member. A stored list that is empty only because its columns were deleted follows the default again.
- Lock order for writers: workbooks (in id order), then the table, then rows, then columns.
