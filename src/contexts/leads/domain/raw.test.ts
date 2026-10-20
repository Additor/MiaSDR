import { describe, expect, it } from "vitest";
import { capRaw, mergeRaw, rawUnchanged, RAW_LIMITS, splitUnmapped } from "./raw";

describe("capRaw", () => {
  it("drops blanks, trims and keeps text as is", () => {
    const { raw } = capRaw([["Notes", "  hi "], ["Empty", "  "], ["N", null]]);
    expect(raw).toEqual({ Notes: "hi" });
  });
  it("keeps formula-looking text unchanged", () => {
    expect(capRaw([["x", "=1+1"]]).raw.x).toBe("=1+1");
  });
  it("cuts values to the per-value cap and reports them", () => {
    const r = capRaw([["long", "a".repeat(RAW_LIMITS.maxValueChars + 50)]]);
    expect(r.raw.long).toHaveLength(RAW_LIMITS.maxValueChars);
    expect(r.truncatedKeys).toEqual(["long"]);
  });
  it("caps the key count and reports the rest", () => {
    const entries: Array<[string, string]> = Array.from({ length: RAW_LIMITS.maxKeys + 5 }, (_, i) => [`k${i}`, "v"]);
    const r = capRaw(entries);
    expect(Object.keys(r.raw)).toHaveLength(RAW_LIMITS.maxKeys);
    expect(r.droppedKeys).toHaveLength(5);
  });
  it("caps the total size", () => {
    const entries: Array<[string, string]> = Array.from({ length: 20 }, (_, i) => [`k${i}`, "x".repeat(RAW_LIMITS.maxValueChars)]);
    const r = capRaw(entries);
    const total = Object.entries(r.raw).reduce((n, [k, v]) => n + k.length + v.length, 0);
    expect(total).toBeLessThanOrEqual(RAW_LIMITS.maxTotalChars);
    // Seven keys of 2,002 characters fit under 16,000; the eighth and every later one do not.
    expect(r.droppedKeys).toEqual(entries.slice(7).map(([key]) => key));
  });
  it("drops oversized keys and prototype keys", () => {
    const r = capRaw([["k".repeat(RAW_LIMITS.maxKeyChars + 1), "v"], ["__proto__", "v"]]);
    expect(r.raw).toEqual({});
    expect(r.droppedKeys).toHaveLength(1);
    expect(Object.getPrototypeOf(r.raw)).toBe(Object.prototype);
  });
});

describe("mergeRaw", () => {
  it("incoming wins per key and stored keys stay", () => {
    expect(mergeRaw({ a: "1", b: "2" }, { b: "3", c: "4" }).raw).toEqual({ a: "1", b: "3", c: "4" });
  });
  it("stringifies non-text stored values", () => {
    expect(mergeRaw({ n: 5 }, {}).raw).toEqual({ n: "5" });
  });
  it("is idempotent", () => {
    const once = mergeRaw({ a: "1" }, { b: "2" }).raw;
    expect(mergeRaw(once, { b: "2" }).raw).toEqual(once);
    expect(rawUnchanged(once, { b: "2" })).toBe(true);
    expect(rawUnchanged(once, { b: "9" })).toBe(false);
  });
});

describe("splitUnmapped", () => {
  const mapping = { Email: "email", Skipped: "skip", Region: "skip", "Company Size": "skip", Name: "full_name" };
  const headers = ["Email", "Skipped", "Region", "Company Size", "Name", "Unlisted"];
  it("keeps unmapped and skipped columns, company-prefixed ones go to the company", () => {
    const row = { Email: "a@b.co", Skipped: "x", Region: "EMEA", "Company Size": "50", Name: "A", Unlisted: "u" };
    expect(splitUnmapped(headers, mapping, row)).toEqual({
      person: [["Skipped", "x"], ["Region", "EMEA"], ["Unlisted", "u"]],
      company: [["Company Size", "50"]],
    });
  });
  it("omits blank cells", () => {
    expect(splitUnmapped(["A"], {}, { A: " " })).toEqual({ person: [], company: [] });
  });
});
