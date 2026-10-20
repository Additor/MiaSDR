import { and, asc, desc, eq, inArray, lte, sql } from "drizzle-orm";
import { db } from "@/platform/db/client";
import { channelSettings, gridCellRuns, gridColumns, gridRows, gridTables, organizations } from "@/platform/db/schema";
import { canonicalTimeZone } from "@/shared/time-zone";
import { NotFoundError } from "@/shared/errors";
import type { CellRunStore, ColumnRecord, FormulaStore } from "../application/ports";
import type { ColumnType } from "../domain/column-types";
import { LookupFailure, lookupSignature, lookupValueKey, type FormulaLookupRegistry } from "../domain/formula";
import { asRow } from "./row-sql";

/** Rows of one lookup source table. Past this the lookup is refused instead of loading an unbounded table. */
const MAX_LOOKUP_ROWS = 50_000;

export const drizzleFormulaStore: FormulaStore = {
  async organizationTimeZone(organizationId) {
    // Same rule as the organization settings: the `general` channel row wins when it holds a valid zone.
    const [org] = await db.select({ timezone: organizations.timezone }).from(organizations).where(eq(organizations.id, organizationId));
    const [general] = await db.select({ values: channelSettings.values }).from(channelSettings).where(and(eq(channelSettings.organizationId, organizationId), eq(channelSettings.channel, "general")));
    const mirrored = general?.values?.timeZone;
    const zone = typeof mirrored === "string" ? canonicalTimeZone(mirrored) : null;
    return zone ?? canonicalTimeZone(org?.timezone) ?? "UTC";
  },

  async lookupRegistry(organizationId, tableId, calls) {
    const registry: FormulaLookupRegistry = {};
    if (calls.length === 0) return registry;

    const [current] = await db.select({ workbookId: gridTables.workbookId }).from(gridTables).where(and(eq(gridTables.organizationId, organizationId), eq(gridTables.id, tableId)));
    if (!current) throw new NotFoundError("Table not found");
    const tables = await db.select({ id: gridTables.id, name: gridTables.name }).from(gridTables).where(and(eq(gridTables.organizationId, organizationId), eq(gridTables.workbookId, current.workbookId)));
    const columns = tables.length
      ? await db
          .select({ tableId: gridColumns.tableId, id: gridColumns.id, key: gridColumns.key, name: gridColumns.name })
          .from(gridColumns)
          .where(and(eq(gridColumns.organizationId, organizationId), inArray(gridColumns.tableId, tables.map((t) => t.id))))
      : [];

    for (const call of calls) {
      const signature = lookupSignature(call.table, call.lookupColumn, call.returnColumn);
      const matches = tables.filter((t) => t.id === call.table || t.name.toLowerCase() === call.table.trim().toLowerCase());
      if (matches.length !== 1) {
        registry[signature] = new LookupFailure("REF", `LOOKUP table "${call.table}" is unknown or ambiguous`);
        continue;
      }
      const table = matches[0];
      const own = columns.filter((c) => c.tableId === table.id);
      const resolve = (token: string) => {
        const found = own.filter((c) => c.id === token || c.key === token || c.name.toLowerCase() === token.trim().toLowerCase());
        return found.length === 1 ? found[0] : null;
      };
      const lookupColumn = resolve(call.lookupColumn);
      const returnColumn = resolve(call.returnColumn);
      const missing = !lookupColumn ? call.lookupColumn : !returnColumn ? call.returnColumn : null;
      if (!lookupColumn || !returnColumn) {
        registry[signature] = new LookupFailure("REF", `LOOKUP column "${missing}" in "${table.name}" is unknown or ambiguous`);
        continue;
      }

      const rows = await db
        .select({ cells: gridRows.cells })
        .from(gridRows)
        .where(and(eq(gridRows.organizationId, organizationId), eq(gridRows.tableId, table.id)))
        .orderBy(asc(gridRows.position))
        .limit(MAX_LOOKUP_ROWS + 1);
      if (rows.length > MAX_LOOKUP_ROWS) {
        registry[signature] = new LookupFailure("LOOKUP", `LOOKUP source table "${table.name}" has more than ${MAX_LOOKUP_ROWS.toLocaleString("en-US")} rows`);
        continue;
      }

      const values = new Map<string, unknown>();
      for (const row of rows) {
        const key = row.cells[lookupColumn.key];
        // A blank lookup value matches nothing, so LOOKUP over a blank cell returns the default.
        if (key === null || key === undefined || (typeof key === "string" && key.trim() === "")) continue;
        const entry = lookupValueKey(key);
        if (!values.has(entry)) values.set(entry, row.cells[returnColumn.key] ?? null);
      }
      registry[signature] = values;
    }
    return registry;
  },

  async formulaColumns(organizationId, workbookId) {
    const rows = await db
      .select({ column: gridColumns })
      .from(gridColumns)
      .innerJoin(gridTables, eq(gridTables.id, gridColumns.tableId))
      .where(and(eq(gridColumns.organizationId, organizationId), eq(gridTables.organizationId, organizationId), eq(gridTables.workbookId, workbookId), eq(gridColumns.type, "formula")))
      .orderBy(asc(gridTables.position), asc(gridColumns.position), asc(gridColumns.id));
    return rows.map(({ column }): ColumnRecord => ({
      id: column.id,
      tableId: column.tableId,
      key: column.key,
      name: column.name,
      type: column.type as ColumnType,
      config: column.config,
      dependsOn: column.dependsOn,
      position: column.position,
      autoRun: column.autoRun,
      createdAt: column.createdAt,
      updatedAt: column.updatedAt,
    }));
  },

  async previewRow(organizationId, tableId, rowId) {
    const [row] = await db
      .select()
      .from(gridRows)
      .where(rowId ? and(eq(gridRows.organizationId, organizationId), eq(gridRows.tableId, tableId), eq(gridRows.id, rowId)) : and(eq(gridRows.organizationId, organizationId), eq(gridRows.tableId, tableId)))
      .orderBy(asc(gridRows.position), asc(gridRows.id))
      .limit(1);
    if (!row) return null;
    // The grid numbers rows 1, 2, 3 in display order. `position` has gaps where rows were deleted.
    const [{ ordinal }] = await db
      .select({ ordinal: sql<number>`count(*)::int` })
      .from(gridRows)
      .where(and(eq(gridRows.organizationId, organizationId), eq(gridRows.tableId, tableId), lte(gridRows.position, row.position)));
    return { row: asRow(row), rowNumber: Number(ordinal) };
  },
};

export const drizzleCellRunStore: CellRunStore = {
  async latestRun(organizationId, tableId, rowId, sourceColumnKey) {
    const [run] = await db
      .select({
        id: gridCellRuns.id,
        provider: gridCellRuns.provider,
        outcome: gridCellRuns.outcome,
        costCents: gridCellRuns.costCents,
        latencyMs: gridCellRuns.latencyMs,
        request: gridCellRuns.request,
        response: gridCellRuns.response,
        createdAt: gridCellRuns.createdAt,
      })
      .from(gridCellRuns)
      .where(and(eq(gridCellRuns.organizationId, organizationId), eq(gridCellRuns.tableId, tableId), eq(gridCellRuns.rowId, rowId), eq(gridCellRuns.columnKey, sourceColumnKey)))
      .orderBy(desc(gridCellRuns.createdAt))
      .limit(1);
    return run ? { ...run, costCents: Number(run.costCents ?? 0) } : null;
  },
};
