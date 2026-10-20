import { isEditableColumn } from "../view/format";
import type { Bounds } from "../view/selection";
import type { CellEditInput, GridColumn, GridRow } from "../data/types";

export interface FillPlan {
  updates: CellEditInput[];
  /** Cells in formula, AI and enrichment columns. A fill never writes them. Includes `skippedFormula`. */
  skippedRunner: number;
  /** The part of `skippedRunner` in formula columns. */
  skippedFormula: number;
}

/**
 * Drag-down fill, duplicate only: the rows below the selection copy the selected rows, repeating the block when the
 * drag is longer than it (a pattern of three rows fills a ten-row drag as 3, 3, 3, 1). Numbers do not count up and
 * dates do not step. Only the loaded rows can be a target, and a column that a run fills is skipped.
 */
export function planFill(source: Bounds, toRow: number, rows: readonly GridRow[], columns: readonly GridColumn[]): FillPlan {
  const height = source.r1 - source.r0 + 1;
  const last = Math.min(toRow, rows.length - 1);
  const updates: CellEditInput[] = [];
  let skippedRunner = 0;
  let skippedFormula = 0;
  for (let r = source.r1 + 1; r <= last; r++) {
    const from = rows[source.r0 + ((r - source.r1 - 1) % height)];
    const to = rows[r];
    for (let c = source.c0; c <= source.c1; c++) {
      const column = columns[c];
      if (!column || !from || !to) continue;
      if (!isEditableColumn(column)) {
        skippedRunner += 1;
        if (column.type === "formula") skippedFormula += 1;
        continue;
      }
      updates.push({ rowId: to.id, columnKey: column.key, value: from.cells[column.key] ?? null });
    }
  }
  return { updates, skippedRunner, skippedFormula };
}
