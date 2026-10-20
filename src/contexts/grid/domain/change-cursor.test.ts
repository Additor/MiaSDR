import { describe, expect, it } from "vitest";
import { formatChangeCursor, parseChangeCursor } from "./change-cursor";

describe("change cursor", () => {
  it("round-trips a settled and a paging cursor", () => {
    const settled = { version: 10, watermark: 500, after: 10, next: null };
    expect(parseChangeCursor(formatChangeCursor(settled))).toEqual(settled);
    const paging = { version: 10, watermark: 500, after: 40, next: 520 };
    expect(parseChangeCursor(formatChangeCursor(paging))).toEqual(paging);
  });

  it("reads a bare version from an older client with no watermark", () => {
    expect(parseChangeCursor("42")).toEqual({ version: 42, watermark: null, after: 42, next: null });
  });

  it("rejects anything else", () => {
    for (const bad of ["", "-1", "1:2", "a:b:c:d", "1:2:3:x", "1.5", "1:2:3:4:5", "9007199254740993"]) expect(parseChangeCursor(bad), bad).toBeNull();
  });
});
