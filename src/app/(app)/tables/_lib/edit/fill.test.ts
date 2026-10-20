import { describe, expect, it } from "vitest";
import { planFill } from "./fill";
import type { GridColumn, GridRow } from "../data/types";

const col = (key: string, type: GridColumn["type"] = "text"): GridColumn => ({ id: key, tableId: "t", key, name: key, type, config: {}, dependsOn: [], position: 0, autoRun: false });
const row = (id: string, cells: Record<string, unknown> = {}): GridRow => ({ id, position: 0, cells, cellMeta: {}, version: 1 });

describe("planFill", () => {
  const columns = [col("a"), col("b", "number"), col("f", "formula")];
  const rows = [row("r1", { a: "x", b: 1, f: 2 }), row("r2", { a: "y", b: 2 }), row("r3"), row("r4"), row("r5"), row("r6")];

  it("copies one selected row down the drag", () => {
    const plan = planFill({ r0: 0, r1: 0, c0: 0, c1: 1 }, 2, rows, columns);
    expect(plan.updates).toEqual([
      { rowId: "r2", columnKey: "a", value: "x" },
      { rowId: "r2", columnKey: "b", value: 1 },
      { rowId: "r3", columnKey: "a", value: "x" },
      { rowId: "r3", columnKey: "b", value: 1 },
    ]);
  });

  it("repeats a block of rows when the drag is longer than the block", () => {
    const plan = planFill({ r0: 0, r1: 1, c0: 0, c1: 0 }, 5, rows, columns);
    expect(plan.updates.map((u) => [u.rowId, u.value])).toEqual([["r3", "x"], ["r4", "y"], ["r5", "x"], ["r6", "y"]]);
  });

  it("does not count numbers up: a copied number stays the same", () => {
    const plan = planFill({ r0: 0, r1: 1, c0: 1, c1: 1 }, 3, rows, columns);
    expect(plan.updates.map((u) => u.value)).toEqual([1, 2]);
  });

  it("skips columns that a run fills and counts them", () => {
    const plan = planFill({ r0: 0, r1: 0, c0: 0, c1: 2 }, 1, rows, columns);
    expect(plan.updates.map((u) => u.columnKey)).toEqual(["a", "b"]);
    expect(plan.skippedRunner).toBe(1);
  });

  it("stops at the last loaded row and sends empty cells as null", () => {
    const plan = planFill({ r0: 2, r1: 2, c0: 0, c1: 0 }, 99, rows, columns);
    expect(plan.updates).toHaveLength(3);
    expect(plan.updates.every((u) => u.value === null)).toBe(true);
  });

  it("does nothing when the drag does not leave the selection", () => {
    expect(planFill({ r0: 1, r1: 2, c0: 0, c1: 0 }, 2, rows, columns).updates).toEqual([]);
    expect(planFill({ r0: 1, r1: 2, c0: 0, c1: 0 }, 0, rows, columns).updates).toEqual([]);
  });
});
