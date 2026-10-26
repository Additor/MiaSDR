import { describe, expect, it } from "vitest";
import { csvCell, csvLine, neutralizeFormula, restoreFormula, UTF8_BOM } from "./csv";

describe("csv export", () => {
  it.each(["=SUM(A1)", "+1+1", "-2+3", "@cmd", "\tcmd", "\rcmd", "  =HYPERLINK(\"x\")", "\n=1"])("neutralizes %j", (text) => {
    expect(neutralizeFormula(text)).toBe(`'${text}`);
    expect(csvCell(text).includes("'")).toBe(true);
  });

  it("leaves safe text alone", () => {
    expect(neutralizeFormula("Acme, Inc")).toBe("Acme, Inc");
    expect(neutralizeFormula("a=b")).toBe("a=b");
    expect(csvCell(42)).toBe("42");
    expect(csvCell(-5)).toBe("-5");
    expect(csvCell(null)).toBe("");
    expect(csvCell(true)).toBe("true");
  });

  it("quotes commas, quotes and line breaks", () => {
    expect(csvCell('say "hi", ok')).toBe('"say ""hi"", ok"');
    expect(csvCell("a\nb")).toBe('"a\nb"');
    expect(csvCell({ a: 1 })).toBe('"{""a"":1}"');
  });

  it("neutralizes a formula inside a JSON-looking string too", () => {
    expect(csvLine(["=1", "x"])).toBe("'=1,x\r\n");
  });

  it("restores exactly what neutralize added", () => {
    for (const text of ["=1+1", "+x", "-5", "@a", "\tz", "plain", "'quoted", "'=already"]) {
      const restored = restoreFormula(neutralizeFormula(text));
      expect(restored).toBe(text);
    }
    expect(restoreFormula("'hello")).toBe("'hello");
  });
});

describe("csv cells from people exports", () => {
  it.each(["=SUM(A1)", "+1+1", "-2+3", "@cmd", "\tTAB", "\rCR"])("prefixes a quote when a cell starts with %j", (value) => {
    expect(csvCell(value).replace(/^"|"$/g, "")).toMatch(/^'/);
  });

  it("keeps a formula-like cell that starts later in the text", () => {
    expect(csvCell("a=1")).toBe("a=1");
  });

  it("quotes commas, quotes and line breaks", () => {
    expect(csvCell('say "hi", ok')).toBe('"say ""hi"", ok"');
    expect(csvCell("one\ntwo")).toBe('"one\ntwo"');
  });

  it("quotes a formula cell that also needs quoting", () => {
    expect(csvCell("=A1,B1")).toBe(`"'=A1,B1"`);
  });

  it("writes null and undefined as empty, and dates as ISO", () => {
    expect(csvCell(null)).toBe("");
    expect(csvCell(undefined)).toBe("");
    expect(csvCell(new Date("2026-10-14T01:02:03Z"))).toBe("2026-10-14T01:02:03.000Z");
  });

  it("leaves Korean text alone", () => {
    expect(csvCell("회사 규모")).toBe("회사 규모");
  });
});

describe("csvLine", () => {
  it("ends with CRLF and joins with commas", () => {
    expect(csvLine(["a", 1, null, "=x"])).toBe("a,1,,'=x\r\n");
  });
  it("exposes a UTF-8 BOM", () => {
    expect(UTF8_BOM).toBe("﻿");
  });
});
