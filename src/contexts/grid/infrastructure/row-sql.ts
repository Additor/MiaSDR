import { sql } from "drizzle-orm";
import type { DbTx } from "@/platform/db/client";
import { ValidationError } from "@/shared/errors";
import type { CellEdit, RowRecord } from "../application/ports";
import type { gridRows } from "@/platform/db/schema";

export type Tx = DbTx;

export const asRow = (row: typeof gridRows.$inferSelect): RowRecord => ({
  id: row.id,
  tableId: row.tableId,
  position: row.position,
  cells: row.cells,
  cellMeta: row.cellMeta,
  version: Number(row.version),
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

/** A bound text[]. A bare JS array would expand into a tuple. */
export const textArray = (values: readonly string[]) => sql`ARRAY[${sql.join(values.map((v) => sql`${v}`), sql`, `)}]::text[]`;

const CHUNK = 250;

/**
 * One edit per row. Repeated edits to a row union their columns, the later value wins per column, and
 * the rows keep the order of their first appearance. A row that names two different expectedVersion
 * values has no single version to check, so that is a validation error.
 */
export function mergeEdits(edits: readonly CellEdit[]): CellEdit[] {
  const byRow = new Map<string, CellEdit>();
  for (const edit of edits) {
    const merged = byRow.get(edit.rowId);
    if (!merged) {
      byRow.set(edit.rowId, { rowId: edit.rowId, set: { ...edit.set }, meta: edit.meta ? { ...edit.meta } : undefined, expectedVersion: edit.expectedVersion, expected: edit.expected ? { ...edit.expected } : undefined });
      continue;
    }
    if (edit.expectedVersion !== undefined) {
      if (merged.expectedVersion !== undefined && merged.expectedVersion !== edit.expectedVersion) {
        throw new ValidationError(`Edits to row ${edit.rowId} name different expectedVersion values (${merged.expectedVersion} and ${edit.expectedVersion})`);
      }
      merged.expectedVersion = edit.expectedVersion;
    }
    Object.assign(merged.set, edit.set);
    if (edit.meta) merged.meta = { ...merged.meta, ...edit.meta };
    if (edit.expected) merged.expected = { ...merged.expected, ...edit.expected };
  }
  return [...byRow.values()];
}

/**
 * Merges a jsonb patch into the cells of many rows, a chunk per statement. The version trigger runs
 * for each updated row. Returns how many rows were updated.
 * UPDATE ... FROM (VALUES ...) applies one source row per target row and drops the others, so patches
 * for the same row are merged first (later keys win).
 */
export async function patchCells(
  tx: Pick<Tx, "execute">,
  organizationId: string,
  tableId: string,
  input: ReadonlyArray<{ rowId: string; patch: Record<string, unknown>; meta?: Record<string, Record<string, unknown> | null> }>,
): Promise<number> {
  const merged = new Map<string, { patch: Record<string, unknown>; meta: Record<string, Record<string, unknown> | null> }>();
  for (const { rowId, patch, meta } of input) {
    const before = merged.get(rowId);
    merged.set(rowId, { patch: { ...before?.patch, ...patch }, meta: { ...before?.meta, ...meta } });
  }
  const patches = [...merged].map(([rowId, { patch, meta }]) => ({
    rowId,
    patch,
    // Metadata entries set to null leave the cell metadata, the rest replace the entry of their column.
    metaSet: Object.fromEntries(Object.entries(meta).filter(([, value]) => value !== null)),
    metaRemove: Object.entries(meta).filter(([, value]) => value === null).map(([key]) => key),
  }));
  let updated = 0;
  for (let offset = 0; offset < patches.length; offset += CHUNK) {
    const values = sql.join(
      patches
        .slice(offset, offset + CHUNK)
        .map(({ rowId, patch, metaSet, metaRemove }) => sql`(${rowId}::uuid, ${JSON.stringify(patch)}::jsonb, ${JSON.stringify(metaSet)}::jsonb, ${JSON.stringify(metaRemove)}::jsonb)`),
      sql`, `,
    );
    const rows = await tx.execute<{ id: string }>(sql`
      update grid_rows set cells = grid_rows.cells || source.patch,
        cell_meta = (grid_rows.cell_meta - array(select jsonb_array_elements_text(source.meta_remove))) || source.meta_set,
        updated_at = now()
      from (values ${values}) as source(id, patch, meta_set, meta_remove)
      where grid_rows.id = source.id and grid_rows.table_id = ${tableId} and grid_rows.organization_id = ${organizationId}
      returning grid_rows.id as id`);
    updated += rows.length;
  }
  return updated;
}
