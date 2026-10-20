import { describe, expect, it } from "vitest";
import { clipboardCell, GROWTH_NEEDS_TABLE_ORDER, parseClipboard, pasteSummary, planPaste, ROWS_NOT_LOADED, routePaste, serializeClipboard, skippedCellsText } from "./paste";
import type { GridColumn, GridRow } from "../data/types";

const col = (key: string, type: GridColumn["type"] = "text"): GridColumn => ({ id: key, tableId: "t", key, name: key, type, config: {}, dependsOn: [], position: 0, autoRun: false });
const row = (id: string): GridRow => ({ id, position: 0, cells: {}, cellMeta: {}, version: 1 });

describe("parseClipboard", () => {
  it("splits tabs and lines and drops one trailing newline", () => {
    expect(parseClipboard("a\tb\nc\td\n")).toEqual([["a", "b"], ["c", "d"]]);
    expect(parseClipboard("a\r\nb")).toEqual([["a"], ["b"]]);
  });
  it("reads quoted cells with tabs, quotes and line breaks", () => {
    expect(parseClipboard('"a\tb"\t"say ""hi"""\n"line1\nline2"\tx')).toEqual([["a\tb", 'say "hi"'], ["line1\nline2", "x"]]);
  });
  it("keeps empty cells", () => {
    expect(parseClipboard("a\t\tc")).toEqual([["a", "", "c"]]);
    expect(parseClipboard("")).toEqual([[""]]);
  });
  it("round trips with serializeClipboard", () => {
    const matrix = [["a", 'x\t"y"'], ["multi\nline", ""]];
    expect(parseClipboard(serializeClipboard(matrix))).toEqual(matrix);
  });
});

describe("planPaste", () => {
  const rows = [row("r1"), row("r2"), row("r3")];
  const columns = [col("a"), col("b", "number"), col("c", "formula")];

  it("lands at the top left corner of the selection", () => {
    const plan = planPaste([["1", "2"], ["3", ""]], { r0: 1, r1: 1, c0: 0, c1: 0 }, rows, columns);
    expect(plan.updates).toEqual([
      { rowId: "r2", columnKey: "a", value: "1" },
      { rowId: "r2", columnKey: "b", value: "2" },
      { rowId: "r3", columnKey: "a", value: "3" },
      { rowId: "r3", columnKey: "b", value: null },
    ]);
    expect(plan.clipped).toBe(false);
  });
  it("clips at the loaded rows and columns and skips runner columns", () => {
    const plan = planPaste([["x", "y", "z", "w"], ["1", "2", "3", "4"], ["5", "6", "7", "8"]], { r0: 2, r1: 2, c0: 0, c1: 0 }, rows, columns);
    expect(plan.updates.map((u) => u.columnKey)).toEqual(["a", "b"]);
    expect(plan.skippedRunner).toBe(1);
    expect(plan.clipped).toBe(true);
  });
  it("fills a selection with one value", () => {
    const plan = planPaste([["v"]], { r0: 0, r1: 1, c0: 0, c1: 1 }, rows, columns);
    expect(plan.updates).toHaveLength(4);
    expect(plan.updates.every((u) => u.value === "v")).toBe(true);
  });
});

describe("clipboardCell", () => {
  it("prefixes text a spreadsheet would run as a formula", () => {
    for (const text of ["=1+1", "+1", "-x", "@cmd", "\tx", "\rx", " =1+1"]) expect(clipboardCell(text)).toBe(`'${text}`);
  });
  it("leaves ordinary text alone", () => {
    expect(clipboardCell("Ada")).toBe("Ada");
    expect(clipboardCell("")).toBe("");
    expect(clipboardCell(null)).toBe("");
  });
  it("leaves numbers and booleans unprefixed, so a numeric -5 differs from the text -5", () => {
    expect(clipboardCell(-5)).toBe("-5");
    expect(clipboardCell("-5")).toBe("'-5");
    expect(clipboardCell(true)).toBe("true");
  });
  it("round trips through planPaste, which restores the apostrophe", () => {
    const columns = [col("a")];
    const rows = [row("r1")];
    const bounds = { r0: 0, r1: 0, c0: 0, c1: 0 };
    for (const text of ["=1+1", "-5", "'=x", "plain"]) {
      const plan = planPaste(parseClipboard(serializeClipboard([[clipboardCell(text)]])), bounds, rows, columns);
      expect(plan.updates).toEqual([{ rowId: "r1", columnKey: "a", value: text }]);
    }
  });
});

describe("routePaste", () => {
  const rows = [row("r1"), row("r2"), row("r3")];
  const columns = [col("a"), col("b")];
  const at = (r: number, c: number) => ({ r0: r, r1: r, c0: c, c1: c });
  const ctx = (over: Partial<Parameters<typeof routePaste>[2]> = {}) => ({ rows, columns, total: 3, keepsOrder: true, ...over });

  it("keeps a block inside the loaded cells on the cell edits", () => {
    const route = routePaste([["x", "y"], ["z", "w"]], at(0, 0), ctx());
    expect(route.kind).toBe("cells");
  });

  it("keeps a single value filled over a selection on the cell edits", () => {
    expect(routePaste([["x"]], { r0: 0, r1: 2, c0: 0, c1: 1 }, ctx()).kind).toBe("cells");
  });

  it("sends a block past the last loaded row to the server, anchored at the first row", () => {
    const route = routePaste([["1"], ["2"], ["3"]], at(2, 0), ctx());
    expect(route).toEqual({ kind: "block", request: { anchorRowId: "r3", columnKeys: ["a"], newColumns: 0, values: [["1"], ["2"], ["3"]] } });
  });

  it("asks for new columns for the width past the last column, and pads short lines", () => {
    const route = routePaste([["1", "2", "3"], ["4"]], at(1, 1), ctx());
    expect(route).toMatchObject({ kind: "block", request: { anchorRowId: "r2", columnKeys: ["b"], newColumns: 2, values: [["1", "2", "3"], ["4", null, null]] } });
  });

  it("restores the copy-time apostrophe and blanks empty cells in a block", () => {
    const route = routePaste([["'=1+1"], [""], ["x"]], at(2, 0), ctx());
    expect(route).toMatchObject({ kind: "block", request: { values: [["=1+1"], [null], ["x"]] } });
  });

  it("refuses growth in a filtered, sorted or searched view, naming the reason", () => {
    expect(routePaste([["1"], ["2"], ["3"]], at(2, 0), ctx({ keepsOrder: false }))).toEqual({ kind: "refuse", message: GROWTH_NEEDS_TABLE_ORDER });
    expect(routePaste([["1"], ["2"], ["3"]], at(2, 0), ctx({ keepsOrder: false, total: 50 }))).toEqual({ kind: "refuse", message: ROWS_NOT_LOADED });
    expect(routePaste([["1", "2", "3"]], at(0, 1), ctx({ keepsOrder: false })).kind).toBe("refuse");
  });

  it("refuses a block over 1,000 rows, 5,000 cells or 100 new columns", () => {
    const tall = Array.from({ length: 1_001 }, () => ["x"]);
    expect(routePaste(tall, at(0, 0), ctx()).kind).toBe("refuse");
    const wide = Array.from({ length: 501 }, () => Array.from({ length: 10 }, () => "x"));
    expect(routePaste(wide, at(0, 0), ctx())).toMatchObject({ kind: "refuse", message: expect.stringContaining("5,000 cells") });
    expect(routePaste([Array.from({ length: 103 }, () => "x")], at(0, 0), ctx())).toMatchObject({ kind: "refuse", message: expect.stringContaining("100 columns") });
  });
});

describe("skippedCellsText", () => {
  it("tells formula columns from AI and enrichment columns", () => {
    expect(skippedCellsText(4, 4)).toBe("Skipped 4 cells in formula columns (they recalculate).");
    expect(skippedCellsText(1, 0)).toBe("Skipped 1 cell in AI or enrichment columns (a run fills them).");
    expect(skippedCellsText(1_003, 3)).toBe("Skipped 3 cells in formula columns (they recalculate) and 1,000 cells in AI or enrichment columns (a run fills them).");
  });

  it("says nothing when no cell was skipped", () => {
    expect(skippedCellsText(0, 0)).toBe("");
  });
});

describe("pasteSummary", () => {
  const base = { cells: 12, addedRows: 0, addedColumns: 0, skippedRunner: 0, skippedFormula: 0, invalidCount: 0 };

  it("reports what was written and created", () => {
    expect(pasteSummary({ ...base, addedRows: 2, addedColumns: 1 })).toBe("Pasted 12 cells and added 2 rows and 1 column.");
    expect(pasteSummary({ ...base, cells: 1 })).toBe("Pasted 1 cell.");
  });

  it("adds why cells were skipped and which ones the column type refused", () => {
    expect(pasteSummary({ ...base, skippedRunner: 5, skippedFormula: 3, invalidCount: 1 })).toBe(
      "Pasted 12 cells. Skipped 3 cells in formula columns (they recalculate) and 2 cells in AI or enrichment columns (a run fills them). 1 cell did not fit the column type and was not saved.",
    );
  });
});

describe("planPaste skips", () => {
  it("counts the formula share of the skipped cells", () => {
    const plan = planPaste([["x", "y", "z"]], { r0: 0, r1: 0, c0: 0, c1: 0 }, [row("r1")], [col("a"), col("f", "formula"), col("ai", "ai")]);
    expect(plan.skippedRunner).toBe(2);
    expect(plan.skippedFormula).toBe(1);
  });
});
