import { describe, expect, it } from "vitest";
import { compileFormula, evaluateFormula, FORMULA_ERROR_TEXT, FORMULA_LIMITS, LookupFailure, lookupSignature, lookupValueKey } from "./formula";

const run = (expression: string, row: Record<string, unknown> = {}, options = {}) => evaluateFormula(expression, row, options);
const value = (expression: string, row: Record<string, unknown> = {}, options = {}) => {
  const result = run(expression, row, options);
  if (!result.ok) throw new Error(`${expression}: ${result.error}`);
  return result.value;
};
const failure = (expression: string, row: Record<string, unknown> = {}) => {
  const result = run(expression, row);
  if (result.ok) throw new Error(`${expression} should fail but gave ${JSON.stringify(result.value)}`);
  return result.error;
};

describe("formula arithmetic and text", () => {
  it("follows operator precedence", () => {
    expect(value("1 + 2 * 3")).toBe(7);
    expect(value("(1 + 2) * 3")).toBe(9);
    expect(value("2 ^ 3 ^ 2")).toBe(512);
    expect(value("-2 ^ 2")).toBe(-4);
    expect(value("10 % 4")).toBe(2);
  });

  it("joins text with + and &", () => {
    expect(value('"a" + "b"')).toBe("ab");
    expect(value('"n=" + 5')).toBe("n=5");
    expect(value('"a" & 1 & null & "c"')).toBe("a1c");
  });

  it("reads cells with {{key}} and strips a leading =", () => {
    expect(value("={{first}} + ' ' + {{last}}", { first: "Ada", last: "Lovelace" })).toBe("Ada Lovelace");
    expect(value("{{a}} * {{b}}", { a: 3, b: "4" })).toBe(12);
  });

  it("reads a blank text cell as empty text and other blanks as null", () => {
    const textKeys = new Set(["last"]);
    expect(value('{{first}} + " " + {{last}}', { first: "Ada" }, { textKeys })).toBe("Ada ");
    expect(value("{{n}}", {}, { textKeys })).toBeNull();
    expect(value("{{last}}", { last: "" }, { textKeys })).toBe("");
  });

  it("compares with loose equality across blanks and numeric text", () => {
    expect(value("{{a}} == ''", {})).toBe(true);
    expect(value("{{a}} = 5", { a: "5" })).toBe(true);
    expect(value("{{a}} <> 5", { a: "6" })).toBe(true);
    expect(value("{{a}} >= 10", { a: "9" })).toBe(false);
    expect(value("'b' > 'a'")).toBe(true);
  });

  it("supports ternary, logic and short circuit", () => {
    expect(value("{{a}} > 1 ? 'big' : 'small'", { a: 2 })).toBe("big");
    expect(value("true || 1 / 0")).toBe(true);
    expect(value("false && 1 / 0")).toBe(false);
    expect(value("IF(true, 1, 1 / 0)")).toBe(1);
    expect(value("!0")).toBe(true);
  });

  it("reports division by zero and non-numbers as errors", () => {
    expect(failure("1 / 0")).toMatch(/Division by zero/);
    expect(failure("'abc' * 2")).toMatch(/not a number/);
    expect(value("IFERROR(1 / 0, 'n/a')")).toBe("n/a");
    expect(failure("10 ^ 1000")).toMatch(/finite/);
  });
});

describe("formula functions", () => {
  it("covers the text functions", () => {
    expect(value("UPPER('ada')")).toBe("ADA");
    expect(value("PROPER('ada LOVELACE')")).toBe("Ada Lovelace");
    expect(value("TRIM('  a   b ')")).toBe("a b");
    expect(value("LEFT('hello', 2) + RIGHT('hello', 2) + MID('hello', 2, 3)")).toBe("heloell");
    expect(value("SUBSTITUTE('a-b-c', '-', '+')")).toBe("a+b+c");
    expect(value("FIND('l', 'hello')")).toBe(3);
    expect(value("CONTAINS('Hello', 'ELL')")).toBe(true);
    expect(value("SPLIT('a,b,c', ',', 2)")).toBe("b");
    expect(value("JOIN(SPLIT('a,b,c', ','), '|')")).toBe("a|b|c");
    expect(value("DOMAIN('https://www.acme.io/path?x=1')")).toBe("acme.io");
    expect(value("DOMAIN('ada@acme.io')")).toBe("acme.io");
    expect(value("CONCATENATE('a', 1, true)")).toBe("a1true");
    expect(value("TEXTJOIN(', ', 'a', '', 'b')")).toBe("a, b");
  });

  it("covers math and aggregates", () => {
    expect(value("SUM(1, 2, [3, 4])")).toBe(10);
    expect(value("AVERAGE(2, 4)")).toBe(3);
    expect(value("MIN(3, 1, 2) + MAX(3, 1, 2)")).toBe(4);
    expect(value("ROUND(2.567, 2)")).toBe(2.57);
    expect(value("FLOOR(2.9) + CEILING(2.1) + INT(-2.9)")).toBe(3);
    expect(value("SUM(SEQUENCE(4))")).toBe(10);
    expect(value("COUNT(1, '', null, 'x')")).toBe(2);
  });

  it("covers blanks and coalescing", () => {
    expect(value("COALESCE({{a}}, {{b}}, 'x')", { b: "y" })).toBe("y");
    expect(value("ISBLANK({{a}})")).toBe(true);
    expect(value("ISNUMBER('1,200')")).toBe(true);
    expect(value("NUMBER('$1,200.50')")).toBe(1200.5);
  });

  it("rejects arity mistakes and unknown functions", () => {
    expect(failure("IF()")).toMatch(/IF takes/);
    expect(failure("NOPE(1)")).toMatch(/Unknown function NOPE/);
  });

  it("looks values up in a registry and falls back to the default", () => {
    const entries = new Map([[lookupValueKey("acme.io"), "Software"]]);
    const lookups = { [lookupSignature("Companies", "Domain", "Industry")]: entries };
    const expr = 'LOOKUP("Companies", {{domain}}, "Domain", "Industry", "unknown")';
    expect(value(expr, { domain: "acme.io" }, { lookups })).toBe("Software");
    expect(value(expr, { domain: "other.io" }, { lookups })).toBe("unknown");
    expect(value(expr, { domain: "" }, { lookups })).toBe("unknown");
    expect(value('LOOKUP("Companies", 1, "Domain", "Industry")', {}, {})).toBeNull();
  });

  it("lists the cells and lookups a formula reads", () => {
    const compiled = compileFormula('{{a}} + LOOKUP("T", {{b}}, "K", "V") + {{a}}');
    expect(compiled.ok && compiled.formula.references).toEqual({ cells: ["a", "b"], lookups: [{ table: "T", lookupColumn: "K", returnColumn: "V" }], volatile: false, usesDates: false });
    expect(compileFormula("LOOKUP({{x}}, 1, 'a', 'b')").ok).toBe(false);
    expect(compileFormula('LOOKUP("T", 1, "K")').ok).toBe(false);
  });
});

describe("formula injection attempts", () => {
  const hostile = [
    "constructor",
    "this.constructor.constructor('return process')()",
    "process.exit(1)",
    "globalThis",
    "require('fs')",
    "import('fs')",
    "eval('1')",
    "Function('return 1')()",
    "({}).constructor",
    "[].constructor.constructor('return 1')()",
    "__proto__",
    "a.b",
    "'a'.length",
    "x => x",
    "`${1}`",
    "1; 2",
    "{{a}}.toString()",
    "$x",
    "@x",
    "{{a.b}}",
    "{{ constructor }}.x",
    "toString()",
    "valueOf()",
    "hasOwnProperty('a')",
  ];

  it.each(hostile)("rejects %s", (expression) => {
    const result = run(expression, { a: "x", constructor: "c" });
    expect(result.ok).toBe(false);
  });

  it("treats prototype names as plain unknown functions", () => {
    expect(failure("constructor('x')")).toMatch(/Unknown function CONSTRUCTOR/);
    expect(failure("__proto__('x')")).toMatch(/Unknown function/);
  });

  it("never reaches the prototype through a cell key", () => {
    expect(value("{{constructor}}", {})).toBeNull();
    expect(value("{{__proto__}}", {})).toBeNull();
    expect(value("{{toString}}", {})).toBeNull();
    expect(value("{{hasOwnProperty}}", { hasOwnProperty: "mine" })).toBe("mine");
  });

  it("treats cell contents as data, never as formula text", () => {
    expect(value("{{a}} + 'x'", { a: "{{b}} + 1" })).toBe("{{b}} + 1x");
    expect(value("{{a}}", { a: "=1+1" })).toBe("=1+1");
    expect(value("{{a}} + ''", { a: { nested: { deep: true } } })).toBe('{"nested":{"deep":true}}');
  });
});

describe("formula resource limits", () => {
  it("rejects an expression over the length cap without parsing it", () => {
    const result = run("1+".repeat(FORMULA_LIMITS.maxLength) + "1");
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toMatch(/longer than/);
  });

  it("rejects deep nesting before recursing into it", () => {
    for (const open of ["(", "-", "!", "[", "ABS(", "IF(true,"]) {
      const text = open.repeat(FORMULA_LIMITS.maxDepth + 5) + "1";
      expect(run(text).ok).toBe(false);
    }
    const deep = "(".repeat(2000) + "1" + ")".repeat(2000);
    const started = Date.now();
    expect(run(deep).ok).toBe(false);
    expect(Date.now() - started).toBeLessThan(500);
  });

  it("accepts nesting just under the cap", () => {
    const depth = FORMULA_LIMITS.maxDepth - 4;
    expect(value("(".repeat(depth) + "1" + ")".repeat(depth))).toBe(1);
  });

  it("rejects a long chain that would make the tree too tall", () => {
    const chain = Array.from({ length: 1000 }, () => "1").join("+");
    const result = run(chain);
    expect(result.ok).toBe(false);
  });

  it("caps huge ranges and lists", () => {
    expect(failure("SEQUENCE(1000000000)")).toMatch(/SEQUENCE length must be between/);
    expect(failure("SUM(SEQUENCE(10000), SEQUENCE(10000), SEQUENCE(10000), SEQUENCE(10000), SEQUENCE(10000), SEQUENCE(10000), SEQUENCE(10000))")).toMatch(/too much work/);
    const split = run("SPLIT(REPEAT('a,', 40000), ',')");
    expect(split.ok && Array.isArray(split.value) && split.value.length).toBe(FORMULA_LIMITS.maxArrayLength);
  });

  it("caps text growth", () => {
    expect(failure("REPEAT('abcdefghij', 100000)")).toMatch(/longer than/);
    expect(failure("REPEAT(REPEAT('a', 50000), 3)")).toMatch(/longer than/);
    let expr = "'x'";
    for (let i = 0; i < 20; i += 1) expr = `${expr} + ${expr}`;
    expect(compileFormula(expr).ok).toBe(false);
    expect(failure("CONCATENATE(REPEAT('a', 60000), REPEAT('b', 60000))")).toMatch(/longer than/);
  });

  it("stops a formula that needs too many steps", () => {
    const terms = Array.from({ length: 30 }, () => "SUM(SEQUENCE(5000))").join(",");
    const started = Date.now();
    expect(failure(`SUM(${terms})`)).toMatch(/too much work/);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("caps the argument count and list size", () => {
    expect(compileFormula(`SUM(${Array.from({ length: 40 }, () => "1").join(",")})`).ok).toBe(false);
    expect(compileFormula(`[${Array.from({ length: 300 }, () => "1").join(",")}]`).ok).toBe(false);
  });

  it("caps an oversized cell value instead of copying it whole", () => {
    const big = "x".repeat(FORMULA_LIMITS.maxStringLength * 2);
    const result = run("LEN({{a}})", { a: big });
    expect(result.ok && result.value).toBe(FORMULA_LIMITS.maxStringLength);
  });

  it("reports an exploding exponent as an error, not a crash", () => {
    expect(failure("9 ^ 9 ^ 9 ^ 9")).toMatch(/finite/);
    expect(failure("1e999")).toMatch(/too large/);
  });
});

describe("LOOKUP errors", () => {
  const expr = 'LOOKUP("Companies", {{domain}}, "Domain", "Industry", "unknown")';
  const sig = lookupSignature("Companies", "Domain", "Industry");

  it("fails with the reason and code of a source that did not resolve, never with the default", () => {
    const lookups = { [sig]: new LookupFailure("REF", 'LOOKUP table "Companies" is unknown or ambiguous') };
    expect(run(expr, { domain: "acme.io" }, { lookups })).toEqual({ ok: false, error: 'LOOKUP table "Companies" is unknown or ambiguous', code: "REF" });
    expect(run(expr, { domain: "" }, { lookups })).toMatchObject({ ok: false, code: "REF" });
  });

  it("fails with LOOKUP when a registry exists but holds no entry for the call", () => {
    expect(run(expr, { domain: "acme.io" }, { lookups: {} })).toMatchObject({ ok: false, code: "LOOKUP", error: expect.stringContaining("Companies") });
  });

  it("keeps the default for a value that is not in a source that did resolve", () => {
    const lookups = { [sig]: new Map([[lookupValueKey("acme.io"), "Software"]]) };
    expect(value(expr, { domain: "other.io" }, { lookups })).toBe("unknown");
  });

  it("lets IFERROR catch a failed source on purpose", () => {
    const lookups = { [sig]: new LookupFailure("REF", "gone") };
    expect(value(`IFERROR(${expr}, "fallback")`, { domain: "a" }, { lookups })).toBe("fallback");
  });

  it("labels other failures ERROR and names the cell texts", () => {
    expect(run("1 / 0")).toMatchObject({ ok: false, code: "ERROR" });
    expect(run("NOPE(")).toMatchObject({ ok: false, code: "ERROR" });
    expect(FORMULA_ERROR_TEXT).toEqual({ ERROR: "#ERROR", REF: "#REF", LOOKUP: "#LOOKUP" });
  });
});
