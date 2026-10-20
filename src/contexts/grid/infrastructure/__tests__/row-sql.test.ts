import { describe, expect, it } from "vitest";
import { ValidationError } from "@/shared/errors";
import { mergeEdits } from "../row-sql";

describe("mergeEdits", () => {
  it("unions the columns of repeated edits and lets the later value win", () => {
    const merged = mergeEdits([
      { rowId: "r1", set: { a: 1, b: 1 } },
      { rowId: "r2", set: { a: 9 } },
      { rowId: "r1", set: { b: 2, c: 3 } },
    ]);
    expect(merged).toEqual([
      { rowId: "r1", set: { a: 1, b: 2, c: 3 }, expectedVersion: undefined },
      { rowId: "r2", set: { a: 9 }, expectedVersion: undefined },
    ]);
  });

  it("keeps the one expectedVersion a row names, and fails when two disagree", () => {
    expect(mergeEdits([{ rowId: "r1", set: { a: 1 } }, { rowId: "r1", set: { b: 1 }, expectedVersion: 7 }, { rowId: "r1", set: { c: 1 }, expectedVersion: 7 }])[0].expectedVersion).toBe(7);
    expect(() => mergeEdits([{ rowId: "r1", set: { a: 1 }, expectedVersion: 7 }, { rowId: "r1", set: { b: 1 }, expectedVersion: 8 }])).toThrow(ValidationError);
  });
});
