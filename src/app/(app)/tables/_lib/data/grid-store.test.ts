import { describe, expect, it, vi } from "vitest";
import { RESOLVE_CONFLICT_FIRST } from "./cell-request";
import type { GridResponse } from "./client";
import { createGridStore } from "./grid-store";
import type { GridRow } from "./types";
import { mergeLoaded } from "../edit/merge-loaded";

const row = (id: string, version: number, cells: Record<string, unknown> = {}): GridRow => ({ id, position: 0, cells, cellMeta: {}, version });
const ok = <T,>(data: T): GridResponse<T> => ({ ok: true, status: 200, data, error: null, failure: null });
const refused = (status: number, error: string, failure: Record<string, unknown> | null = null): GridResponse<never> => ({ ok: false, status, data: null, error, failure });
/** Lets every promise that can move on do so. */
const idle = () => new Promise((resolve) => setImmediate(resolve));

interface Call {
  method: string;
  body: { updates?: Array<{ rowId: string; columnKey: string; value: unknown; expectedVersion?: number }>; undo?: boolean; rowIds?: string[] };
  answer: (res: GridResponse<unknown>) => void;
}

/** A store whose requests wait until the test answers them, in whatever order it likes. */
function harness(rows: GridRow[] = [row("r1", 1, { a: "old" }), row("r2", 1, { a: "old" })]) {
  const calls: Call[] = [];
  const toast = { error: vi.fn(), warning: vi.fn(), message: vi.fn() };
  const request = <T,>(_url: string, method: string, body?: unknown) => new Promise<GridResponse<T>>((resolve) => calls.push({ method, body: body as Call["body"], answer: (res) => resolve(res as GridResponse<T>) }));
  const store = createGridStore({ tableId: "t", request, toast });
  store.putRows(rows);
  return { store, calls, toast };
}

const namesRow = (call: Call, id: string) => call.body.updates?.some((u) => u.rowId === id) ?? false;

/** Answers a cell save for its updates, each stored as sent, at `version`. */
function saved(call: Call, version: number) {
  const updates = call.body.updates ?? [];
  call.answer(ok({ rows: updates.map((u) => row(u.rowId, version, { [u.columnKey]: u.value })), applied: updates.map((u) => ({ rowId: u.rowId, columnKey: u.columnKey, value: u.value })) }));
}

const edit = (rowId: string, value: unknown = "new") => ({ rowId, columnKey: "a", value });

describe("a table load that lands after an edit", () => {
  it("keeps the row the edit's answer brought, and the next edit expects its version", async () => {
    const { store, calls } = harness();
    store.edit([edit("r1")]);
    await idle();
    saved(calls[0], 5);
    await idle();

    // A page that read the row before the save, folded in the way the hook's load folds it.
    store.putRows(mergeLoaded(store.rows(), [row("r1", 1, { a: "old" }), row("r2", 1, { a: "old" })]));
    expect(store.rows()[0]).toMatchObject({ version: 5, cells: { a: "new" } });

    store.edit([edit("r1", "newer")]);
    await idle();
    expect(calls[1].body.updates?.[0].expectedVersion).toBe(5);
  });
});

describe("a request about the table", () => {
  it("goes out after the queued edits land, those typed while it waits too", async () => {
    const { store, calls } = harness();
    const sent = vi.fn(async () => "sent");
    store.edit([edit("r1")]);
    const result = store.whenSettled(sent, () => "refused");
    await idle();
    expect(sent).not.toHaveBeenCalled();

    store.edit([edit("r2")]);
    saved(calls[0], 2);
    await idle();
    expect(sent).not.toHaveBeenCalled();
    expect(namesRow(calls[1], "r2")).toBe(true);

    saved(calls[1], 3);
    expect(await result).toBe("sent");
    expect(store.snapshot().pending.size).toBe(0);
  });

  it("is refused while the conflict dialog holds an edit back, and goes out after it is resolved", async () => {
    const { store, calls } = harness();
    store.edit([edit("r1")]);
    await idle();
    calls[0].answer(refused(409, "Conflict", { conflicts: [{ rowId: "r1", expectedVersion: 1, currentVersion: 4, cells: { a: "theirs" } }] }));
    await idle();
    expect(store.snapshot().conflict?.items[0]).toMatchObject({ mine: "new", theirs: "theirs" });

    const sent = vi.fn(async () => "sent");
    expect(await store.whenSettled(sent, () => "refused")).toBe("refused");
    expect(sent).not.toHaveBeenCalled();
    expect(await store.settle()).toBe(false);

    store.resolveConflict("retry");
    await idle();
    expect(calls[1].body.updates?.[0]).toMatchObject({ rowId: "r1", value: "new", expectedVersion: 4 });
    saved(calls[1], 5);
    expect(await store.whenSettled(sent, () => "refused")).toBe("sent");
  });

  it("does not bring back an edit the server refused", async () => {
    const { store, calls, toast } = harness();
    store.edit([edit("r1")]);
    await idle();
    calls[0].answer(refused(422, "Not a number"));
    await idle();
    expect(toast.error).toHaveBeenCalledWith("Not a number");
    expect(store.snapshot()).toMatchObject({ canUndo: false, saving: false });
    expect(store.snapshot().pending.size).toBe(0);
  });
});

describe("a row delete", () => {
  it("saves the other rows' edits first and never sends an edit of a row about to go", async () => {
    const { store, calls } = harness();
    store.edit([edit("r1"), edit("r2")]);
    const outcome = store.deleteRows(["r1"]);
    await idle();
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("PATCH");
    expect(namesRow(calls[0], "r2")).toBe(true);
    expect(namesRow(calls[0], "r1")).toBe(false);

    saved(calls[0], 2);
    await idle();
    expect(calls[1].method).toBe("DELETE");
    expect(calls[1].body.rowIds).toEqual(["r1"]);

    calls[1].answer(ok({ deleted: 1 }));
    expect(await outcome).toEqual({ deleted: 1, failedFrom: -1, error: null });
    await idle();
    expect(calls).toHaveLength(2);
    expect(store.snapshot().pending.size).toBe(0);
  });

  it("holds an edit typed during the delete, and drops it and its undo step when the row goes", async () => {
    const { store, calls } = harness();
    const outcome = store.deleteRows(["r1"]);
    await idle();
    expect(calls[0].method).toBe("DELETE");

    store.edit([edit("r1")]);
    await idle();
    // On screen, not sent.
    expect(store.snapshot().pending.size).toBe(1);
    expect(store.snapshot().canUndo).toBe(true);
    expect(calls).toHaveLength(1);

    calls[0].answer(ok({ deleted: 1 }));
    await outcome;
    await idle();
    expect(calls).toHaveLength(1);
    expect(store.snapshot().pending.size).toBe(0);
    expect(store.snapshot().canUndo).toBe(false);
  });

  it("sends the held edits again for rows the server kept", async () => {
    const { store, calls } = harness();
    const outcome = store.deleteRows(["r1"]);
    await idle();
    store.edit([edit("r1")]);
    await idle();

    calls[0].answer(refused(500, "Server error"));
    expect(await outcome).toEqual({ deleted: 0, failedFrom: 0, error: "Server error" });
    await idle();
    expect(calls[1].method).toBe("PATCH");
    expect(namesRow(calls[1], "r1")).toBe(true);
  });

  it("is refused while the conflict dialog is open", async () => {
    const { store, calls } = harness();
    store.edit([edit("r2")]);
    await idle();
    calls[0].answer(refused(409, "Conflict", { conflicts: [{ rowId: "r2", expectedVersion: 1, currentVersion: 4, cells: { a: "theirs" } }] }));
    await idle();

    expect(await store.deleteRows(["r1"])).toEqual({ deleted: 0, failedFrom: 0, error: RESOLVE_CONFLICT_FIRST });
    expect(calls).toHaveLength(1);
  });
});

describe("undo", () => {
  it("waits for the queued edit and expects the value the server stored", async () => {
    const { store, calls, toast } = harness();
    store.edit([edit("r1", "42")]);
    const done = store.undo();
    await idle();
    expect(calls).toHaveLength(1);

    calls[0].answer(ok({ rows: [row("r1", 2, { a: 42 })], applied: [{ rowId: "r1", columnKey: "a", value: 42 }] }));
    await idle();
    expect(calls[1].body).toMatchObject({ undo: true, updates: [{ rowId: "r1", columnKey: "a", value: "old", expected: 42 }] });

    calls[1].answer(ok({ rows: [row("r1", 3, { a: "old" })], applied: [{ rowId: "r1", columnKey: "a", value: "old" }] }));
    await done;
    expect(store.snapshot()).toMatchObject({ canUndo: false, canRedo: true });
    expect(toast.message).toHaveBeenCalledWith("Undid 1 cell.", { id: "grid-history" });
  });

  it("runs one step at a time", async () => {
    const { store, calls } = harness();
    store.edit([edit("r1")]);
    await idle();
    saved(calls[0], 2);
    await idle();

    const first = store.undo();
    void store.undo();
    await idle();
    expect(calls).toHaveLength(2);
    calls[1].answer(ok({ rows: [], applied: [] }));
    await first;
  });

  it("says why it waits while the conflict dialog is open", async () => {
    const { store, calls, toast } = harness();
    store.edit([edit("r1")]);
    await idle();
    calls[0].answer(refused(409, "Conflict", { conflicts: [{ rowId: "r1", expectedVersion: 1, currentVersion: 4, cells: { a: "theirs" } }] }));
    await idle();

    await store.undo();
    expect(toast.message).toHaveBeenCalledWith(RESOLVE_CONFLICT_FIRST, { id: "grid-history" });
    expect(calls).toHaveLength(1);
  });
});

describe("the snapshot", () => {
  it("stays the same object while nothing on screen changes", async () => {
    const { store } = harness();
    const before = store.snapshot();
    store.resetHistory();
    expect(store.snapshot()).toBe(before);
  });

  it("tells a subscriber until it leaves", () => {
    const { store } = harness();
    const listener = vi.fn();
    const leave = store.subscribe(listener);
    store.putRows([]);
    expect(listener).toHaveBeenCalledTimes(1);
    leave();
    store.putRows([]);
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
