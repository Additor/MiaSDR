import { describe, expect, it } from "vitest";
import { duplicateColumnRequest, isColumnActionOffered, pinBlockedReason, type ColumnActionContext } from "./column-actions";

const ctx = (type: string, pinned = false, pinCount = 0): ColumnActionContext => ({ column: { type }, pinned, pinCount });

describe("isColumnActionOffered", () => {
  it("offers the kinds without a column rule on any column", () => {
    for (const kind of ["rename", "sort", "hide", "delete", "run"] as const) expect(isColumnActionOffered(kind, ctx("text"))).toBe(true);
  });

  it("offers pin until three columns are pinned, and unpin only on a pinned column", () => {
    expect(isColumnActionOffered("pin", ctx("text", false, 2))).toBe(true);
    expect(isColumnActionOffered("pin", ctx("text", false, 3))).toBe(false);
    expect(isColumnActionOffered("pin", ctx("text", true, 1))).toBe(false);
    expect(isColumnActionOffered("unpin", ctx("text", true, 1))).toBe(true);
    expect(isColumnActionOffered("unpin", ctx("text"))).toBe(false);
  });

  it("offers duplicate for static and formula columns, not for runner or output columns", () => {
    for (const type of ["text", "number", "formula"]) expect(isColumnActionOffered("duplicate", ctx(type))).toBe(true);
    for (const type of ["ai", "enrichment", "waterfall", "ai_output", "integration_output", "http"]) expect(isColumnActionOffered("duplicate", ctx(type))).toBe(false);
  });

  it("offers the first-N run on runner columns only", () => {
    expect(isColumnActionOffered("runFirstN", ctx("ai"))).toBe(true);
    expect(isColumnActionOffered("runFirstN", ctx("text"))).toBe(false);
    expect(isColumnActionOffered("runFirstN", ctx("ai_output"))).toBe(false);
  });
});

describe("duplicate column", () => {
  it("copies a data column's values and keeps its type and config", () => {
    expect(duplicateColumnRequest({ id: "c1", key: "score", name: "Score", type: "number", config: { decimals: 2 } })).toEqual({
      name: "Score (copy)",
      type: "number",
      config: { decimals: 2 },
      afterColumnId: "c1",
      copyValuesFrom: "score",
    });
  });

  it("copies a formula's expression and leaves its values to the recalculation", () => {
    const request = duplicateColumnRequest({ id: "c2", key: "double", name: "Double", type: "formula", config: { expression: "{{score}} * 2" } });
    expect(request).toMatchObject({ type: "formula", config: { expression: "{{score}} * 2" }, afterColumnId: "c2" });
    expect(request).not.toHaveProperty("copyValuesFrom");
  });

  it("returns nothing for a runner column", () => {
    expect(duplicateColumnRequest({ id: "c3", key: "ai", name: "AI", type: "ai", config: {} })).toBeNull();
  });
});

describe("pinBlockedReason", () => {
  it("names the limit once three columns are pinned", () => {
    expect(pinBlockedReason({ pinned: false, pinCount: 3 })).toBe("Up to 3 columns can be pinned");
  });

  it("says nothing while a pin is open or the column is pinned already", () => {
    expect(pinBlockedReason({ pinned: false, pinCount: 2 })).toBeNull();
    expect(pinBlockedReason({ pinned: true, pinCount: 3 })).toBeNull();
  });
});
