import { describe, expect, it } from "vitest";
import { countOf, formatCount } from "./format-number";

describe("format-number", () => {
  it("groups thousands the English way", () => {
    expect(formatCount(1204)).toBe("1,204");
  });

  it("puts the noun in the right number", () => {
    expect(countOf(1, "lead")).toBe("1 lead");
    expect(countOf(1204, "lead")).toBe("1,204 leads");
    expect(countOf(2, "reply", "replies")).toBe("2 replies");
  });
});
