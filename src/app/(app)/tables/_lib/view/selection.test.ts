import { describe, expect, it } from "vitest";
import { boundsOf, cellCount, emptySelection, extendRange, headerState, inBounds, movePos, pruneSelection, selectAllLoaded, single, tabPos, toggleRow } from "./selection";

const dims = { rows: 5, cols: 4 };

describe("movePos", () => {
  it("moves and clamps at the edges", () => {
    expect(movePos({ row: 0, col: 0 }, "ArrowUp", dims)).toEqual({ row: 0, col: 0 });
    expect(movePos({ row: 0, col: 0 }, "ArrowDown", dims)).toEqual({ row: 1, col: 0 });
    expect(movePos({ row: 4, col: 3 }, "ArrowRight", dims)).toEqual({ row: 4, col: 3 });
  });
  it("jumps to edges with ctrl", () => {
    expect(movePos({ row: 2, col: 2 }, "ArrowDown", dims, { jump: true })).toEqual({ row: 4, col: 2 });
    expect(movePos({ row: 2, col: 2 }, "Home", dims, { jump: true })).toEqual({ row: 0, col: 0 });
    expect(movePos({ row: 2, col: 2 }, "End", dims, { jump: true })).toEqual({ row: 4, col: 3 });
  });
  it("pages and homes within a row", () => {
    expect(movePos({ row: 1, col: 2 }, "PageDown", dims, { pageSize: 10 })).toEqual({ row: 4, col: 2 });
    expect(movePos({ row: 3, col: 2 }, "Home", dims)).toEqual({ row: 3, col: 0 });
  });
  it("ignores other keys and empty grids", () => {
    expect(movePos({ row: 0, col: 0 }, "a", dims)).toBeNull();
    expect(movePos({ row: 0, col: 0 }, "ArrowDown", { rows: 0, cols: 0 })).toBeNull();
  });
});

describe("tabPos", () => {
  it("wraps to the next row and back", () => {
    expect(tabPos({ row: 0, col: 3 }, dims, false)).toEqual({ row: 1, col: 0 });
    expect(tabPos({ row: 1, col: 0 }, dims, true)).toEqual({ row: 0, col: 3 });
  });
  it("stays at the ends", () => {
    expect(tabPos({ row: 4, col: 3 }, dims, false)).toEqual({ row: 4, col: 3 });
    expect(tabPos({ row: 0, col: 0 }, dims, true)).toEqual({ row: 0, col: 0 });
  });
});

describe("ranges", () => {
  it("normalizes a backwards range", () => {
    const b = boundsOf(extendRange(single({ row: 3, col: 2 }), { row: 1, col: 0 }));
    expect(b).toEqual({ r0: 1, r1: 3, c0: 0, c1: 2 });
    expect(cellCount(b)).toBe(9);
    expect(inBounds(b, { row: 2, col: 1 })).toBe(true);
    expect(inBounds(b, { row: 4, col: 1 })).toBe(false);
  });
});

describe("row selection", () => {
  const ids = ["a", "b", "c", "d", "e"];
  it("toggles one row", () => {
    const one = toggleRow(emptySelection, ids, 1);
    expect([...one.ids]).toEqual(["b"]);
    expect(toggleRow(one, ids, 1).ids.size).toBe(0);
  });
  it("selects a range with shift", () => {
    const first = toggleRow(emptySelection, ids, 1);
    const range = toggleRow(first, ids, 3, { range: true });
    expect([...range.ids].sort()).toEqual(["b", "c", "d"]);
  });
  it("deselects a range with shift when the clicked row is selected", () => {
    const anchored = { ...selectAllLoaded(ids), anchor: 0 };
    const next = toggleRow(anchored, ids, 2, { range: true });
    expect([...next.ids].sort()).toEqual(["d", "e"]);
  });
  it("reports the header state", () => {
    expect(headerState(emptySelection, ids)).toBe("none");
    expect(headerState(toggleRow(emptySelection, ids, 0), ids)).toBe("some");
    expect(headerState(selectAllLoaded(ids), ids)).toBe("all");
    expect(headerState(selectAllLoaded(ids), [])).toBe("none");
  });
  it("prunes ids that no longer exist", () => {
    const sel = selectAllLoaded(ids);
    expect([...pruneSelection(sel, new Set(["a", "b"])).ids]).toEqual(["a", "b"]);
    expect(pruneSelection(sel, new Set(ids))).toBe(sel);
  });
});
