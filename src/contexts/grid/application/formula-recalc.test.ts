import { describe, expect, it } from "vitest";
import { LookupFailure, lookupSignature, lookupValueKey } from "../domain/formula";
import { previewFormula } from "./formula-management";
import { formulasToRecalculate, isVolatileColumn, recalculateFormulas } from "./formula-recalc";
import type { CellEdit, ColumnRecord, RowRecord } from "./ports";

const col = (key: string, type: ColumnRecord["type"], extra: Partial<ColumnRecord> = {}): ColumnRecord => ({
  id: key, tableId: "t", key, name: key, type, config: {}, dependsOn: [], position: 0, autoRun: true, createdAt: new Date(), updatedAt: new Date(), ...extra,
});
const formula = (key: string, expression: string, dependsOn: string[], extra: Partial<ColumnRecord> = {}) => col(key, "formula", { config: { expression }, dependsOn, ...extra });

describe("formulasToRecalculate", () => {
  const columns = [col("a", "text"), col("b", "text"), formula("f1", "{{a}}", ["a"]), formula("f2", "{{f1}}", ["f1"]), formula("manual", "{{a}}", ["a"], { autoRun: false })];

  it("picks formulas that read a changed key, and the formulas that read those", () => {
    expect(formulasToRecalculate(columns, { changedKeys: ["a"] }).map((c) => c.key)).toEqual(["f1", "f2"]);
  });
  it("skips formulas that read nothing that changed", () => {
    expect(formulasToRecalculate(columns, { changedKeys: ["b"] })).toEqual([]);
  });
  it("always includes a named column, even with auto-run off", () => {
    expect(formulasToRecalculate(columns, { columnKeys: ["manual"] }).map((c) => c.key)).toEqual(["manual"]);
  });
});

describe("volatile formulas", () => {
  const columns = [col("a", "text"), col("b", "text"), formula("today", "TODAY()", []), formula("age", "DATEDIF({{a}}, TODAY(), 'D')", ["a"]), formula("after", "{{today}}", ["today"]), formula("manual", "NOW()", [], { autoRun: false }), formula("plain", "UPPER({{b}})", ["b"])];
  const keys = (scope: Parameters<typeof formulasToRecalculate>[1]) => formulasToRecalculate(columns, scope).map((c) => c.key);

  it("marks the formula that calls TODAY or NOW and nothing else", () => {
    expect(columns.filter(isVolatileColumn).map((c) => c.key)).toEqual(["today", "age", "manual"]);
  });
  it("joins a row edit even when the edit touches an unrelated column, and drags its dependents along", () => {
    expect(keys({ changedKeys: ["b"] })).toEqual(["today", "age", "plain", "after"]);
  });
  it("skips a volatile formula with auto-run off on an edit", () => {
    expect(keys({ changedKeys: ["b"] })).not.toContain("manual");
  });
  it("is picked by Recalculate (a named column) even with auto-run off, and only that column plus its dependents", () => {
    expect(keys({ columnKeys: ["manual"] })).toEqual(["manual"]);
    expect(keys({ columnKeys: ["today"] })).toEqual(["today", "after"]);
  });
  it("does not run on a run that names other columns, such as a lookup refresh of a different formula", () => {
    expect(keys({ columnKeys: ["plain"] })).toEqual(["plain"]);
  });
  it("is not scheduled: an empty scope picks nothing", () => {
    expect(keys({})).toEqual([]);
    expect(keys({ changedKeys: [] })).toEqual([]);
  });

  const row = (id: string, cells: Record<string, unknown>): RowRecord => ({ id, tableId: "t", position: 1, cells, cellMeta: {}, version: 1, createdAt: new Date(), updatedAt: new Date() });
  const harness = (clockIso: () => string, zone = "Asia/Seoul") => {
    const rows = [row("r1", { a: "2026-03-01" }), row("r2", { a: "2026-03-01" })];
    const written: CellEdit[] = [];
    let zoneReads = 0;
    const deps = {
      columns: { list: async () => [col("a", "text"), formula("age", "DATEDIF({{a}}, TODAY(), 'D')", ["a"]), formula("upper", "UPPER({{a}})", ["a"])] },
      rows: {
        scan: async function* () { yield rows; },
        listByIds: async (_o: string, _t: string, ids: string[]) => rows.filter((r) => ids.includes(r.id)),
        applyEdits: async (_o: string, _t: string, e: CellEdit[]) => {
          written.push(...e);
          for (const edit of e) Object.assign(rows.find((r) => r.id === edit.rowId)!.cells, edit.set);
          return { rows: [], previous: new Map() };
        },
      },
      formulas: { lookupRegistry: async () => ({}), organizationTimeZone: async () => { zoneReads += 1; return zone; } },
    };
    const recalc = (scope: Parameters<typeof recalculateFormulas>[3]) => recalculateFormulas(deps as never, "o", "t", scope, { now: () => new Date(clockIso()) });
    return { recalc, written, rows, zoneReads: () => zoneReads };
  };

  it("does not recalculate on an unrelated edit of another row, and does on Recalculate", async () => {
    let clock = "2026-03-05T00:00:00Z";
    const h = harness(() => clock);
    await h.recalc({ columnKeys: ["age"] });
    expect(h.rows.map((r) => r.cells.age)).toEqual([4, 4]);
    h.written.length = 0;

    clock = "2026-03-06T00:00:00Z";
    await h.recalc({ rowIds: ["r2"], changedKeys: ["a"] });
    // The edit touched r2 only, so r1 still shows the old day count.
    expect(h.rows.map((r) => r.cells.age)).toEqual([4, 5]);

    await h.recalc({ columnKeys: ["age"] });
    expect(h.rows.map((r) => r.cells.age)).toEqual([5, 5]);
  });

  it("uses the organization zone and reads it once per run", async () => {
    const h = harness(() => "2026-03-05T15:30:00Z", "Asia/Seoul");
    await h.recalc({ columnKeys: ["age"] });
    expect(h.rows[0].cells.age).toBe(5);
    expect(h.zoneReads()).toBe(1);

    const la = harness(() => "2026-03-05T15:30:00Z", "America/Los_Angeles");
    await la.recalc({ columnKeys: ["age"] });
    expect(la.rows[0].cells.age).toBe(4);
  });

  it("leaves the zone unread when no formula uses a date function", async () => {
    const h = harness(() => "2026-03-05T15:30:00Z");
    await h.recalc({ columnKeys: ["upper"] });
    expect(h.zoneReads()).toBe(0);
  });

  it("does not touch an unchanged volatile cell", async () => {
    const h = harness(() => "2026-03-05T15:30:00Z");
    await h.recalc({ columnKeys: ["age"] });
    h.written.length = 0;
    await h.recalc({ rowIds: ["r1"], changedKeys: ["a"] });
    expect(h.written.flatMap((e) => Object.keys(e.set))).not.toContain("age");
  });
});

describe("recalculateFormulas", () => {
  it("writes chained results once and leaves unchanged cells alone", async () => {
    const columns = [col("a", "text"), formula("f1", 'UPPER({{a}})', ["a"]), formula("f2", '{{f1}} & "!"', ["f1"])];
    const rows: RowRecord[] = [
      { id: "r1", tableId: "t", position: 1, cells: { a: "x" }, cellMeta: {}, version: 1, createdAt: new Date(), updatedAt: new Date() },
      { id: "r2", tableId: "t", position: 2, cells: { a: "y", f1: "Y", f2: "Y!" }, cellMeta: {}, version: 1, createdAt: new Date(), updatedAt: new Date() },
    ];
    const written: CellEdit[] = [];
    const deps = {
      columns: { list: async () => columns },
      rows: { scan: async function* () { yield rows; }, listByIds: async () => rows, applyEdits: async (_o: string, _t: string, e: CellEdit[]) => { written.push(...e); return { rows: [], previous: new Map() }; } },
      formulas: { lookupRegistry: async () => ({}) },
    };
    const changed = await recalculateFormulas(deps as never, "o", "t", { changedKeys: ["a"] });
    expect(changed).toBe(2);
    expect(written).toEqual([{ rowId: "r1", set: { f1: "X", f2: "X!" } }]);
  });
});

describe("recalculateFormulas errors", () => {
  const lookupFormula = formula("f", 'LOOKUP("Companies", {{a}}, "Domain", "Industry", "none")', ["a"]);
  const row = (id: string, cells: Record<string, unknown>, cellMeta: Record<string, unknown> = {}): RowRecord => ({ id, tableId: "t", position: 1, cells, cellMeta, version: 1, createdAt: new Date(), updatedAt: new Date() });
  const run = async (columns: ColumnRecord[], rows: RowRecord[], lookups: Record<string, unknown>) => {
    const written: CellEdit[] = [];
    const deps = {
      columns: { list: async () => columns },
      rows: { scan: async function* () { yield rows; }, listByIds: async () => rows, applyEdits: async (_o: string, _t: string, e: CellEdit[]) => { written.push(...e); return { rows: [], previous: new Map() }; } },
      formulas: { lookupRegistry: async () => lookups },
    };
    const changed = await recalculateFormulas(deps as never, "o", "t", { columnKeys: ["f"] });
    return { written, changed };
  };
  const sig = lookupSignature("Companies", "Domain", "Industry");

  it("writes #REF and the reason when the lookup source is gone, not the default", async () => {
    const { written, changed } = await run([col("a", "text"), lookupFormula], [row("r1", { a: "acme.io", f: "Software" })], { [sig]: new LookupFailure("REF", 'LOOKUP table "Companies" is unknown or ambiguous') });
    expect(written).toEqual([{ rowId: "r1", set: { f: "#REF" }, meta: { f: { status: "error", code: "REF", error: 'LOOKUP table "Companies" is unknown or ambiguous' } } }]);
    expect(changed).toBe(1);
  });

  it("writes #LOOKUP when the source could not be read", async () => {
    const { written } = await run([col("a", "text"), lookupFormula], [row("r1", { a: "x" })], { [sig]: new LookupFailure("LOOKUP", "too big") });
    expect(written[0].set).toEqual({ f: "#LOOKUP" });
  });

  it("clears an error or stale marker when the result is good, even if the value is the same", async () => {
    const entries = new Map([[lookupValueKey("acme.io"), "Software"]]);
    const { written } = await run([col("a", "text"), lookupFormula], [row("r1", { a: "acme.io", f: "Software" }, { f: { status: "stale", error: "changed" } })], { [sig]: entries });
    expect(written).toEqual([{ rowId: "r1", set: {}, meta: { f: null } }]);
  });

  it("writes nothing for a good cell without markers", async () => {
    const entries = new Map([[lookupValueKey("acme.io"), "Software"]]);
    const { written } = await run([col("a", "text"), lookupFormula], [row("r1", { a: "acme.io", f: "Software" })], { [sig]: entries });
    expect(written).toEqual([]);
  });

  it("records the reason for an ordinary evaluation error too", async () => {
    const { written } = await run([col("a", "number"), formula("f", "1 / {{a}}", ["a"])], [row("r1", { a: 0 })], {});
    expect(written[0]).toMatchObject({ set: { f: "#ERROR" }, meta: { f: { status: "error", code: "ERROR", error: "Division by zero" } } });
  });

  it("does not leave a cell silent when the stored expression no longer compiles", async () => {
    const { written } = await run([col("a", "text"), formula("f", "(((", ["a"])], [row("r1", { a: "x" })], {});
    expect(written[0]).toMatchObject({ set: { f: "#ERROR" }, meta: { f: { status: "error", code: "ERROR" } } });
  });
});

describe("TEXT and the organization time zone", () => {
  const columns = [col("n", "number"), col("d", "text"), formula("plain", "TEXT({{n}})", ["n"]), formula("dated", 'TEXT({{d}}, "yyyy-mm-dd")', ["d"])];
  const mkRow = () => ({ id: "r1", tableId: "t", position: 1, cells: { n: 5, d: "2026-03-05" } as Record<string, unknown>, cellMeta: {}, version: 1, createdAt: new Date(), updatedAt: new Date() }) as RowRecord;

  async function recalc(columnKeys: string[]) {
    const rows = [mkRow()];
    let zoneReads = 0;
    const deps = {
      columns: { list: async () => columns },
      rows: { scan: async function* () { yield rows; }, listByIds: async () => rows, applyEdits: async (_o: string, _t: string, e: CellEdit[]) => { for (const edit of e) Object.assign(rows[0].cells, edit.set); return { rows: [], previous: new Map() }; } },
      formulas: { lookupRegistry: async () => ({}), organizationTimeZone: async () => { zoneReads += 1; return "Asia/Seoul"; } },
    };
    await recalculateFormulas(deps as never, "o", "t", { columnKeys }, { now: () => new Date("2026-03-05T00:00:00Z") });
    return { zoneReads, cells: rows[0].cells };
  }

  async function preview(expression: string) {
    let zoneReads = 0;
    const deps = {
      structure: { getTable: async () => ({ id: "t" }) },
      columns: { list: async () => columns },
      formulas: { previewRow: async () => ({ row: mkRow(), rowNumber: 1 }), lookupRegistry: async () => ({}), organizationTimeZone: async () => { zoneReads += 1; return "Asia/Seoul"; } },
    };
    const result = await previewFormula(deps as never, { userId: "u", organizationId: "o", role: "owner" }, "t", { expression });
    return { zoneReads, value: result.value };
  }

  it("makes no zone read for TEXT(x) in a recalculation", async () => {
    const out = await recalc(["plain"]);
    expect(out.cells.plain).toBe("5");
    expect(out.zoneReads).toBe(0);
  });
  it("makes no zone read for TEXT(x) in a preview", async () => {
    const out = await preview("TEXT({{n}})");
    expect(out.value).toBe("5");
    expect(out.zoneReads).toBe(0);
  });
  it("still reads the zone for TEXT(x, format) in a recalculation and a preview", async () => {
    expect((await recalc(["dated"])).zoneReads).toBe(1);
    const out = await preview('TEXT({{d}}, "yyyy-mm-dd")');
    expect(out.zoneReads).toBe(1);
    expect(out.value).toBe("2026-03-05");
  });
});
