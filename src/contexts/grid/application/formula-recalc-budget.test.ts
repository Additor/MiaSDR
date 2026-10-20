import { describe, expect, it } from "vitest";
import { RecalcBudgetError, recalculateFormula, recalculateFormulas, recalculateFormulasQuietly } from "./formula-recalc";
import type { CellEdit, ColumnRecord, RowRecord } from "./ports";

const col = (key: string, type: ColumnRecord["type"], extra: Partial<ColumnRecord> = {}): ColumnRecord => ({
  id: key, tableId: "t", key, name: key, type, config: {}, dependsOn: [], position: 0, autoRun: true, createdAt: new Date(), updatedAt: new Date(), ...extra,
});
const columns = [col("a", "text"), col("f", "formula", { config: { expression: "UPPER({{a}})" }, dependsOn: ["a"] })];
const batchOf = (start: number, n: number): RowRecord[] =>
  Array.from({ length: n }, (_, i) => ({ id: `r${start + i}`, tableId: "t", position: start + i, cells: { a: `v${start + i}` }, cellMeta: {}, version: 1, createdAt: new Date(), updatedAt: new Date() }));

function harness(options: { batches?: number; failOnBatch?: number; tick?: () => void } = {}) {
  const batches = Array.from({ length: options.batches ?? 3 }, (_, i) => batchOf(i * 500, 500));
  const writes: CellEdit[][] = [];
  const marks: Array<{ keys: string[]; reason: string; rowIds?: string[] }> = [];
  const deps = {
    columns: { list: async () => columns },
    rows: {
      scan: async function* () {
        for (const b of batches) yield b;
      },
      listByIds: async () => [],
      applyEdits: async (_o: string, _t: string, e: CellEdit[]) => {
        if (options.failOnBatch !== undefined && writes.length + 1 === options.failOnBatch) throw new Error("connection reset");
        writes.push(e);
        options.tick?.();
        return { rows: [], previous: new Map() };
      },
      markStale: async (_o: string, _t: string, keys: string[], reason: string, rowIds?: string[]) => {
        marks.push({ keys, reason, rowIds });
        return 0;
      },
    },
    formulas: { lookupRegistry: async () => ({}) },
  };
  return { deps: deps as never, writes, marks };
}

describe("recalculation budget", () => {
  it("stops between batches once the time budget is spent, and reports how far it got", async () => {
    let now = 0;
    const h = harness({ tick: () => (now += 20_000) });
    const run = recalculateFormulas(h.deps, "o", "t", { columnKeys: ["f"] }, { budgetMs: 30_000, clock: () => now });
    await expect(run).rejects.toBeInstanceOf(RecalcBudgetError);
    await expect(run).rejects.toThrow(/stopped after/i);
    expect(h.writes).toHaveLength(2);
    // The third batch was read and not written; its rows are reported as unfinished.
    await run.catch((e: RecalcBudgetError) => expect(e.remainingRowIds).toEqual(batchOf(1000, 500).map((r) => r.id)));
  });

  it("finishes inside the budget without an error", async () => {
    let now = 0;
    const h = harness({ tick: () => (now += 1_000) });
    await expect(recalculateFormulas(h.deps, "o", "t", { columnKeys: ["f"] }, { budgetMs: 30_000, clock: () => now })).resolves.toBe(1500);
  });
});

describe("a failed recalculation is visible", () => {
  it("marks the formula column stale with the reason when the quiet path fails, instead of returning 0 and nothing else", async () => {
    const h = harness({ failOnBatch: 2 });
    const changed = await recalculateFormulasQuietly(h.deps, "o", "t", { columnKeys: ["f"] });
    expect(changed).toBe(0);
    expect(h.marks).toHaveLength(1);
    expect(h.marks[0].keys).toEqual(["f"]);
    expect(h.marks[0].reason).toMatch(/did not finish/i);
    expect(h.marks[0].reason).toMatch(/connection reset/);
    expect(h.marks[0].reason).toMatch(/Recalculate/);
  });

  it("marks only the rows of an edit when the edit's recalculation fails", async () => {
    const h = harness({ failOnBatch: 1 });
    (h.deps as { rows: { listByIds: unknown } }).rows.listByIds = async () => batchOf(0, 2);
    await recalculateFormulasQuietly(h.deps, "o", "t", { rowIds: ["r0", "r1"], changedKeys: ["a"] });
    expect(h.marks[0].rowIds).toEqual(["r0", "r1"]);
  });

  it("marks only the rows a budget stop did not reach", async () => {
    let now = 0;
    const h = harness({ tick: () => (now += 20_000) });
    const run = recalculateFormulasQuietly(h.deps, "o", "t", { columnKeys: ["f"] }, { budgetMs: 30_000, clock: () => now });
    await expect(run).resolves.toBe(0);
    expect(h.marks).toHaveLength(1);
    expect(h.marks[0].rowIds).toEqual(batchOf(1000, 500).map((r) => r.id));
    expect(h.marks[0].reason).toMatch(/stopped after 30 seconds/);
  });

  it("marks the column and still throws when the explicit Recalculate fails", async () => {
    const h = harness({ failOnBatch: 2 });
    await expect(recalculateFormula(h.deps, "o", "t", "f")).rejects.toThrow(/connection reset/);
    expect(h.marks[0].keys).toEqual(["f"]);
  });

  it("does not hide a failure of the marking itself", async () => {
    const h = harness({ failOnBatch: 1 });
    (h.deps as { rows: { markStale: unknown } }).rows.markStale = async () => {
      throw new Error("database down");
    };
    await expect(recalculateFormulasQuietly(h.deps, "o", "t", { columnKeys: ["f"] })).resolves.toBe(0);
  });

  it("leaves nothing marked when the recalculation succeeds", async () => {
    const h = harness();
    await recalculateFormulasQuietly(h.deps, "o", "t", { columnKeys: ["f"] });
    expect(h.marks).toEqual([]);
  });
});
