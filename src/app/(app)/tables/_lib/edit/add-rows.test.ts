import { describe, expect, it } from "vitest";
import { MAX_ADD_ROWS, pagesToReachEnd, parseRowCount, planSubmit } from "./add-rows";

describe("parseRowCount", () => {
  it("accepts 1 to 1,000, with spaces and thousands commas", () => {
    expect(parseRowCount("1")).toEqual({ ok: true, count: 1 });
    expect(parseRowCount(" 250 ")).toEqual({ ok: true, count: 250 });
    expect(parseRowCount("1,000")).toEqual({ ok: true, count: MAX_ADD_ROWS });
  });

  it("refuses 0, more than 1,000, decimals, signs and text, each with a reason", () => {
    expect(parseRowCount("0")).toEqual({ ok: false, error: "Add at least 1 row." });
    expect(parseRowCount("1001")).toEqual({ ok: false, error: "Add at most 1,000 rows at a time." });
    for (const bad of ["2.5", "-3", "+3", "ten", "1e3"]) expect(parseRowCount(bad).ok).toBe(false);
    expect(parseRowCount("")).toEqual({ ok: false, error: "Enter how many rows to add." });
  });
});

describe("pagesToReachEnd", () => {
  it("counts the pages still missing after the first load", () => {
    expect(pagesToReachEnd(1_200, 200, 200)).toBe(5);
    expect(pagesToReachEnd(250, 200, 200)).toBe(1);
    expect(pagesToReachEnd(200, 200, 200)).toBe(0);
  });

  it("caps the requests on a large table", () => {
    expect(pagesToReachEnd(50_000, 200, 200)).toBe(25);
    expect(pagesToReachEnd(50_000, 200, 200, 5)).toBe(5);
  });
});

describe("planSubmit", () => {
  it("adds the parsed count, or explains why not", () => {
    expect(planSubmit(false, "1,000")).toEqual({ kind: "add", count: 1000 });
    expect(planSubmit(false, "0")).toEqual({ kind: "error", error: "Add at least 1 row." });
  });

  it("does nothing while a request is in flight, even for a valid count", () => {
    expect(planSubmit(true, "1000")).toEqual({ kind: "skip" });
    expect(planSubmit(true, "oops")).toEqual({ kind: "skip" });
  });
});
