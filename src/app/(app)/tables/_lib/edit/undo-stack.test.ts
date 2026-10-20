import { describe, expect, it } from "vitest";
import { canRedo, canUndo, columnsInvalidate, complete, discardCells, drop, EMPTY_STACK, MAX_ACTIONS, nextAction, record, restoreUpdates, settleAfter, type UndoCell } from "./undo-stack";

const cell = (rowId: string, columnKey: string, before: unknown, after: unknown): UndoCell => ({ rowId, columnKey, before, after });

describe("record", () => {
  it("adds an action and makes undo available", () => {
    const stack = record(EMPTY_STACK, "a1", [cell("r1", "a", "old", "new")]);
    expect(canUndo(stack)).toBe(true);
    expect(canRedo(stack)).toBe(false);
    expect(nextAction(stack, "undo")?.id).toBe("a1");
  });

  it("ignores edits that change nothing, treating null, missing and empty text alike", () => {
    expect(record(EMPTY_STACK, "a1", [cell("r1", "a", null, ""), cell("r1", "b", "x", "x"), cell("r1", "c", undefined, null)])).toBe(EMPTY_STACK);
  });

  it("keeps a paste of many cells as one action", () => {
    const stack = record(EMPTY_STACK, "paste", Array.from({ length: 50 }, (_, i) => cell(`r${i}`, "a", null, `v${i}`)));
    expect(stack.done).toHaveLength(1);
    expect(stack.done[0].cells).toHaveLength(50);
  });

  it("merges calls that share an action id: the first before stays, the last after wins", () => {
    let stack = record(EMPTY_STACK, "paste", [cell("r1", "a", "old", "mid")]);
    stack = record(stack, "paste", [cell("r1", "a", "mid", "new"), cell("r2", "a", null, "x")]);
    expect(stack.done).toHaveLength(1);
    expect(stack.done[0].cells).toEqual([cell("r1", "a", "old", "new"), cell("r2", "a", null, "x")]);
  });

  it("drops a merged cell that ended where it began", () => {
    let stack = record(EMPTY_STACK, "p", [cell("r1", "a", "old", "mid")]);
    stack = record(stack, "p", [cell("r1", "a", "mid", "old"), cell("r2", "a", null, "x")]);
    expect(stack.done[0].cells).toEqual([cell("r2", "a", null, "x")]);
  });

  it("clears the redo history", () => {
    let stack = record(EMPTY_STACK, "a1", [cell("r1", "a", "x", "y")]);
    stack = complete(stack, "undo", "a1", [{ rowId: "r1", columnKey: "a", value: "x" }]);
    expect(canRedo(stack)).toBe(true);
    stack = record(stack, "a2", [cell("r1", "a", "x", "z")]);
    expect(canRedo(stack)).toBe(false);
  });

  it("keeps at most 100 actions, dropping the oldest", () => {
    let stack = EMPTY_STACK;
    for (let i = 0; i < MAX_ACTIONS + 5; i++) stack = record(stack, `a${i}`, [cell("r1", "a", `${i}`, `${i + 1}`)]);
    expect(stack.done).toHaveLength(MAX_ACTIONS);
    expect(stack.done[0].id).toBe("a5");
  });
});

describe("undo and redo", () => {
  it("undo writes before and expects after; redo writes after and expects before", () => {
    const stack = record(EMPTY_STACK, "a1", [cell("r1", "a", "old", "new")]);
    expect(restoreUpdates(stack.done[0], "undo")).toEqual([{ rowId: "r1", columnKey: "a", value: "old", expected: "new" }]);
    expect(restoreUpdates(stack.done[0], "redo")).toEqual([{ rowId: "r1", columnKey: "a", value: "new", expected: "old" }]);
  });

  it("moves the action to the other side with the server's stored value", () => {
    let stack = record(EMPTY_STACK, "a1", [cell("r1", "n", "5", 6)]);
    stack = complete(stack, "undo", "a1", [{ rowId: "r1", columnKey: "n", value: 5 }]);
    expect(stack.done).toHaveLength(0);
    // The redo now expects the stored 5, not the typed "5".
    expect(restoreUpdates(nextAction(stack, "redo")!, "redo")).toEqual([{ rowId: "r1", columnKey: "n", value: 6, expected: 5 }]);
    stack = complete(stack, "redo", "a1", [{ rowId: "r1", columnKey: "n", value: 6 }]);
    expect(canRedo(stack)).toBe(false);
    expect(canUndo(stack)).toBe(true);
  });

  it("keeps only the cells the server applied, and forgets an action that applied none", () => {
    let stack = record(EMPTY_STACK, "paste", [cell("r1", "a", null, "x"), cell("r2", "a", null, "y")]);
    stack = complete(stack, "undo", "paste", [{ rowId: "r1", columnKey: "a", value: null }]);
    expect(stack.undone[0].cells.map((c) => c.rowId)).toEqual(["r1"]);
    stack = complete(stack, "redo", "paste", []);
    expect(stack).toEqual({ done: [], undone: [] });
  });

  it("undoes in reverse order of the edits", () => {
    let stack = record(EMPTY_STACK, "a1", [cell("r1", "a", "1", "2")]);
    stack = record(stack, "a2", [cell("r1", "a", "2", "3")]);
    expect(nextAction(stack, "undo")?.id).toBe("a2");
    stack = complete(stack, "undo", "a2", [{ rowId: "r1", columnKey: "a", value: "2" }]);
    expect(nextAction(stack, "undo")?.id).toBe("a1");
    expect(nextAction(stack, "redo")?.id).toBe("a2");
  });

  it("drops an action that cannot run", () => {
    const stack = record(EMPTY_STACK, "a1", [cell("r1", "a", "x", "y")]);
    expect(drop(stack, "undo", "a1").done).toHaveLength(0);
  });
});

describe("recording the server's value", () => {
  it("replaces the typed after with the coerced value", () => {
    let stack = record(EMPTY_STACK, "a1", [cell("r1", "n", 1, "42")]);
    stack = settleAfter(stack, "a1", [{ rowId: "r1", columnKey: "n", value: 42 }]);
    expect(restoreUpdates(stack.done[0], "undo")).toEqual([{ rowId: "r1", columnKey: "n", value: 1, expected: 42 }]);
  });

  it("removes a cell the server stored as it was, and an action left empty", () => {
    let stack = record(EMPTY_STACK, "a1", [cell("r1", "n", 1, "1.0")]);
    stack = settleAfter(stack, "a1", [{ rowId: "r1", columnKey: "n", value: 1 }]);
    expect(stack.done).toHaveLength(0);
  });

  it("discards cells the server refused", () => {
    let stack = record(EMPTY_STACK, "a1", [cell("r1", "a", "x", "y"), cell("r2", "a", "x", "y")]);
    stack = discardCells(stack, "a1", [{ rowId: "r2", columnKey: "a" }]);
    expect(stack.done[0].cells.map((c) => c.rowId)).toEqual(["r1"]);
    stack = discardCells(stack, "a1", [{ rowId: "r1", columnKey: "a" }]);
    expect(stack.done).toHaveLength(0);
  });
});

describe("columnsInvalidate", () => {
  const before = [{ key: "a", type: "text" }, { key: "b", type: "number" }];
  it("is true when a column is deleted or changes type", () => {
    expect(columnsInvalidate(before, [{ key: "a", type: "text" }])).toBe(true);
    expect(columnsInvalidate(before, [{ key: "a", type: "text" }, { key: "b", type: "text" }])).toBe(true);
  });
  it("is false for an added column, a first load or no change", () => {
    expect(columnsInvalidate(before, [...before, { key: "c", type: "text" }])).toBe(false);
    expect(columnsInvalidate([], before)).toBe(false);
    expect(columnsInvalidate(before, before)).toBe(false);
  });
});
