import { describe, expect, it } from "vitest";
import { csvCell, csvLine, neutralizeFormula, restoreFormula } from "./csv";

describe("grid csv export", () => {
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
