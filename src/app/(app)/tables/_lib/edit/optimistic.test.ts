import { describe, expect, it } from "vitest";
import { addPending, applyConflictRows, buildBatches, cellId, clearPending, conflictItems, dropPendingRows, mergeRows, requeueEdits, overlayPending, type PendingMap } from "./optimistic";
import type { GridRow } from "../data/types";

const row = (id: string, version: number, cells: Record<string, unknown> = {}, position = 0): GridRow => ({ id, position, cells, cellMeta: {}, version });

describe("pending edits", () => {
  const rows = [row("r1", 5, { a: "old" }), row("r2", 7)];

  it("overlays pending values without touching the rows", () => {
    const pending = addPending(new Map(), { rowId: "r1", columnKey: "a", value: "new" }, rows[0]);
    const shown = overlayPending(rows, pending);
    expect(shown[0].cells.a).toBe("new");
    expect(rows[0].cells.a).toBe("old");
    expect(shown[1]).toBe(rows[1]);
  });

  it("keeps the older base version when a cell is edited twice", () => {
    let pending: PendingMap = addPending(new Map(), { rowId: "r1", columnKey: "a", value: "x" }, rows[0]);
    pending = addPending(pending, { rowId: "r1", columnKey: "a", value: "y" }, row("r1", 9));
    expect(pending.get(cellId("r1", "a"))).toMatchObject({ value: "y", baseVersion: 5 });
  });

  it("names the current row version in a batch", () => {
    let pending: PendingMap = addPending(new Map(), { rowId: "r1", columnKey: "a", value: "x" }, rows[0]);
    pending = addPending(pending, { rowId: "r1", columnKey: "b", value: "z" }, rows[0]);
    const batches = buildBatches(pending, [row("r1", 6)]);
    expect(batches).toHaveLength(1);
    expect(batches[0].updates.map((u) => u.expectedVersion)).toEqual([6, 6]);
  });

  it("carries the undo step of the latest edit of a cell", () => {
    let pending: PendingMap = addPending(new Map(), { rowId: "r1", columnKey: "a", value: "x" }, rows[0], "act-1");
    pending = addPending(pending, { rowId: "r1", columnKey: "a", value: "y" }, rows[0], "act-2");
    expect(pending.get(cellId("r1", "a"))?.actionId).toBe("act-2");
  });

  it("clears confirmed edits but keeps ones changed in flight", () => {
    let pending: PendingMap = addPending(new Map(), { rowId: "r1", columnKey: "a", value: "x" }, rows[0]);
    pending = addPending(pending, { rowId: "r2", columnKey: "a", value: "later" }, rows[1]);
    const left = clearPending(pending, [
      { rowId: "r1", columnKey: "a", value: "x" },
      { rowId: "r2", columnKey: "a", value: "sent" },
    ]);
    expect([...left.keys()]).toEqual([cellId("r2", "a")]);
  });
});

describe("mergeRows", () => {
  it("replaces a row only with a newer version", () => {
    const existing = [row("r1", 5, { a: 1 })];
    expect(mergeRows(existing, [row("r1", 4, { a: 0 })], { canAppend: false }).rows[0].cells.a).toBe(1);
    const merged = mergeRows(existing, [row("r1", 6, { a: 2 })], { canAppend: false });
    expect(merged.rows[0].cells.a).toBe(2);
    expect(merged.changed).toBe(true);
  });
  it("appends unknown rows in position order when allowed", () => {
    const merged = mergeRows([row("r1", 1, {}, 0)], [row("r3", 3, {}, 2), row("r2", 2, {}, 1)], { canAppend: true });
    expect(merged.rows.map((r) => r.id)).toEqual(["r1", "r2", "r3"]);
  });
  it("counts unknown rows it cannot place", () => {
    const merged = mergeRows([row("r1", 1)], [row("r9", 9)], { canAppend: false });
    expect(merged.unplaced).toBe(1);
    expect(merged.rows).toHaveLength(1);
  });
});

describe("conflicts", () => {
  const conflicts = [
    { rowId: "r1", expectedVersion: 5, currentVersion: 8, cells: { a: "theirs" } },
    { rowId: "r2", expectedVersion: 7, currentVersion: null, cells: null },
  ];
  it("pairs my value with the current one", () => {
    let pending: PendingMap = addPending(new Map(), { rowId: "r1", columnKey: "a", value: "mine" }, row("r1", 5));
    pending = addPending(pending, { rowId: "r2", columnKey: "a", value: "gone" }, row("r2", 7));
    const items = conflictItems(conflicts, pending);
    expect(items[0]).toMatchObject({ mine: "mine", theirs: "theirs", deleted: false, currentVersion: 8 });
    expect(items[1]).toMatchObject({ deleted: true });
  });
  it("moves cached rows to the current version so a retry succeeds", () => {
    const next = applyConflictRows([row("r1", 5, { a: "old" }), row("r2", 7)], conflicts);
    expect(next[0]).toMatchObject({ version: 8, cells: { a: "theirs" } });
    expect(next[1].version).toBe(7);
  });
  it("keeps a cached row that is newer than the 409 reported, so a retry names the newer version", () => {
    // A poll brought v9 after the server answered the 409 with v8.
    const next = applyConflictRows([row("r1", 9, { a: "newest" })], conflicts);
    expect(next[0]).toMatchObject({ version: 9, cells: { a: "newest" } });
    const pending = addPending(new Map(), { rowId: "r1", columnKey: "a", value: "mine" }, row("r1", 5));
    expect(buildBatches(pending, next)[0].updates[0].expectedVersion).toBe(9);
  });
});

describe("dropPendingRows", () => {
  it("drops the queued edits of the given rows and keeps the rest", () => {
    let pending: PendingMap = addPending(new Map(), { rowId: "r1", columnKey: "a", value: "x" }, row("r1", 1));
    pending = addPending(pending, { rowId: "r1", columnKey: "b", value: "y" }, row("r1", 1));
    pending = addPending(pending, { rowId: "r2", columnKey: "a", value: "z" }, row("r2", 1));
    const left = dropPendingRows(pending, ["r1"]);
    expect(left.dropped.map((e) => e.columnKey)).toEqual(["a", "b"]);
    expect([...left.pending.keys()]).toEqual([cellId("r2", "a")]);
  });
});

describe("requeueEdits", () => {
  it("puts held edits back unless the cell was edited again meanwhile", () => {
    let pending: PendingMap = addPending(new Map(), { rowId: "r1", columnKey: "a", value: "held" }, row("r1", 1), "act-1");
    pending = addPending(pending, { rowId: "r1", columnKey: "b", value: "held" }, row("r1", 1), "act-1");
    const { dropped } = dropPendingRows(pending, ["r1"]);
    const later = addPending(new Map(), { rowId: "r1", columnKey: "a", value: "later" }, row("r1", 2), "act-2");
    const back = requeueEdits(later, dropped);
    expect(back.get(cellId("r1", "a"))).toMatchObject({ value: "later", actionId: "act-2" });
    expect(back.get(cellId("r1", "b"))).toMatchObject({ value: "held", baseVersion: 1, actionId: "act-1" });
  });
});

describe("buildBatches", () => {
  const many = (rowCount: number, perRow: number) => {
    let pending: PendingMap = new Map();
    const rows: GridRow[] = [];
    for (let r = 0; r < rowCount; r++) {
      rows.push(row(`r${r}`, 1));
      for (let c = 0; c < perRow; c++) pending = addPending(pending, { rowId: `r${r}`, columnKey: `c${c}`, value: `${r}-${c}` }, rows[r]);
    }
    return { pending, rows };
  };

  it("keeps a small edit in one request", () => {
    const { pending, rows } = many(3, 2);
    const batches = buildBatches(pending, rows);
    expect(batches).toHaveLength(1);
    expect(batches[0].updates).toHaveLength(6);
  });

  it("splits more than 5,000 cells into requests of at most 5,000", () => {
    const { pending, rows } = many(600, 10); // 6,000 cells, 600 rows
    const batches = buildBatches(pending, rows);
    expect(batches.map((b) => b.updates.length)).toEqual([5_000, 1_000]);
    expect(batches.flatMap((b) => b.updates)).toHaveLength(6_000);
  });

  it("splits more than 1,000 rows into requests of at most 1,000 rows", () => {
    const { pending, rows } = many(1_001, 1);
    const batches = buildBatches(pending, rows);
    expect(batches.map((b) => new Set(b.updates.map((u) => u.rowId)).size)).toEqual([1_000, 1]);
  });

  it("never splits one row across requests", () => {
    const { pending, rows } = many(5, 4);
    const batches = buildBatches(pending, rows, { cells: 6, rows: 1_000 });
    expect(batches.map((b) => b.updates.length)).toEqual([4, 4, 4, 4, 4]);
    for (const b of batches) expect(new Set(b.updates.map((u) => u.rowId)).size).toBe(1);
  });

  it("names the current row version in every request", () => {
    const { pending } = many(2, 1);
    const batches = buildBatches(pending, [row("r0", 9), row("r1", 4)], { cells: 1, rows: 1_000 });
    expect(batches.map((b) => b.updates[0].expectedVersion)).toEqual([9, 4]);
  });
});
