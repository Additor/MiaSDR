import { describe, expect, it } from "vitest";
import { rowWindow, scrollToRow } from "./window";

describe("rowWindow", () => {
  it("renders the viewport plus overscan", () => {
    const w = rowWindow({ scrollTop: 300, viewportHeight: 200, rowHeight: 30, count: 1000, overscan: 2 });
    expect(w.start).toBe(8);
    expect(w.end).toBe(19);
    expect(w.offsetTop).toBe(240);
    expect(w.totalHeight).toBe(30_000);
  });
  it("clamps at both ends and handles an empty list", () => {
    expect(rowWindow({ scrollTop: 0, viewportHeight: 100, rowHeight: 30, count: 3, overscan: 5 })).toMatchObject({ start: 0, end: 3 });
    expect(rowWindow({ scrollTop: 99999, viewportHeight: 100, rowHeight: 30, count: 10, overscan: 1 }).end).toBe(10);
    expect(rowWindow({ scrollTop: 0, viewportHeight: 100, rowHeight: 30, count: 0 }).end).toBe(0);
  });
});

describe("scrollToRow", () => {
  it("scrolls only when the row is out of view", () => {
    expect(scrollToRow({ row: 5, scrollTop: 0, viewportHeight: 300, rowHeight: 30 })).toBeNull();
    expect(scrollToRow({ row: 20, scrollTop: 0, viewportHeight: 300, rowHeight: 30 })).toBe(330);
    expect(scrollToRow({ row: 1, scrollTop: 300, viewportHeight: 300, rowHeight: 30 })).toBe(30);
  });
});
