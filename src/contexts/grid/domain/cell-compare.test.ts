import { describe, expect, it } from "vitest";
import { sameCellValue } from "./cell-compare";

describe("sameCellValue", () => {
  it("treats null and a missing value as the same empty cell", () => {
    expect(sameCellValue(null, undefined)).toBe(true);
    expect(sameCellValue(undefined, undefined)).toBe(true);
  });

  it("does not equate empty text, zero or false with an empty cell", () => {
    expect(sameCellValue("", null)).toBe(false);
    expect(sameCellValue(0, null)).toBe(false);
    expect(sameCellValue(false, null)).toBe(false);
  });

  it("compares scalars strictly", () => {
    expect(sameCellValue("a", "a")).toBe(true);
    expect(sameCellValue(1, "1")).toBe(false);
    expect(sameCellValue(true, true)).toBe(true);
  });

  it("compares arrays and objects by content, ignoring key order", () => {
    expect(sameCellValue(["a", "b"], ["a", "b"])).toBe(true);
    expect(sameCellValue(["a", "b"], ["b", "a"])).toBe(false);
    expect(sameCellValue({ a: 1, b: [2] }, { b: [2], a: 1 })).toBe(true);
    expect(sameCellValue({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(sameCellValue([], {})).toBe(false);
  });
});
