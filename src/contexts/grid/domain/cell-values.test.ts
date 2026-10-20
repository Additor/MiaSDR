import { describe, expect, it } from "vitest";
import { cleanJson, cleanString, coerceCellInput, coerceText, convertStoredValue, MAX_CELL_CHARS, parseNumericText } from "./cell-values";

describe("parseNumericText", () => {
  it.each([
    ["1,234.5", 1234.5],
    ["$1,234.50", 1234.5],
    ["USD 12", 12],
    ["-$5", -5],
    ["(1,200)", -1200],
    ["1e3", 1000],
    ["₩5,000", 5000],
  ])("reads %s", (text, expected) => expect(parseNumericText(text)).toBe(expected));

  it.each(["N/A", "12abc", "50%", "", "1e999", "x".repeat(100)])("leaves %j as text", (text) => expect(parseNumericText(text)).toBeNull());
});

describe("coerceText", () => {
  it("keeps text that does not fit the type", () => {
    expect(coerceText("N/A", "number")).toBe("N/A");
    expect(coerceText("maybe", "boolean")).toBe("maybe");
    expect(coerceText("{not json", "json")).toBe("{not json");
  });
  it("converts text that fits", () => {
    expect(coerceText("1,200", "number")).toBe(1200);
    expect(coerceText("Yes", "boolean")).toBe(true);
    expect(coerceText("a; b, c", "multiselect")).toEqual(["a", "b", "c"]);
    expect(coerceText('{"a":1}', "json")).toEqual({ a: 1 });
    expect(coerceText("   ", "text")).toBeNull();
  });
});

describe("coerceCellInput", () => {
  it("rejects values of the wrong shape and oversized text", () => {
    expect(coerceCellInput({ a: 1 }, "number")).toEqual({ ok: false, error: "must be a number" });
    expect(coerceCellInput(Number.POSITIVE_INFINITY, "number").ok).toBe(false);
    expect(coerceCellInput("x".repeat(MAX_CELL_CHARS + 1), "text").ok).toBe(false);
    expect(coerceCellInput([1], "multiselect").ok).toBe(false);
    expect(coerceCellInput({ a: "x".repeat(MAX_CELL_CHARS) }, "json").ok).toBe(false);
  });
  it("stores numbers as text columns expect them", () => {
    expect(coerceCellInput(5, "text")).toEqual({ ok: true, value: "5" });
    expect(coerceCellInput(null, "number")).toEqual({ ok: true, value: null });
    expect(coerceCellInput("12", "number")).toEqual({ ok: true, value: 12 });
  });
});

describe("jsonb safety", () => {
  it("strips NUL and lone surrogates", () => {
    expect(cleanString("a\u0000b")).toBe("ab");
    expect(cleanString("a\uD800b")).toBe("a�b");
  });
  it("cuts a document nested past the depth cap", () => {
    let doc: unknown = "leaf";
    for (let i = 0; i < 40; i += 1) doc = { next: doc };
    expect(JSON.stringify(cleanJson(doc))).toContain("null");
  });
});

describe("convertStoredValue", () => {
  it("converts strings and never destroys data", () => {
    expect(convertStoredValue("1,200", "number")).toBe(1200);
    expect(convertStoredValue("N/A", "number")).toBe("N/A");
    expect(convertStoredValue(12, "text")).toBe("12");
    expect(convertStoredValue(["a", "b"], "text")).toBe("a, b");
    expect(convertStoredValue("  ", "number")).toBeNull();
  });
});
