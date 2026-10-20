import { describe, expect, it } from "vitest";
import { evaluateFormula, FORMULA_LIMITS, referencesOf, parseFormula, compileFormula, type FormulaValue } from "./formula";

const NOW = new Date("2026-03-05T12:00:00Z");
const run = (expression: string, row: Record<string, unknown> = {}, options: { now?: Date; timeZone?: string } = { now: NOW }) => evaluateFormula(expression, row, options);

type Case = [expression: string, expected: FormulaValue | { error: RegExp }, row?: Record<string, unknown>];

function table(cases: Case[]) {
  it.each(cases.map((c) => [c[0], c] as const))("%s", (_name, [expression, expected, row]) => {
    const result = run(expression, row ?? {});
    if (expected !== null && typeof expected === "object" && !Array.isArray(expected) && "error" in expected) {
      expect(result.ok, `${expression} should fail`).toBe(false);
      if (!result.ok) {
        expect(result.error).toMatch(expected.error);
        expect(result.code).toBe("ERROR");
      }
    } else {
      expect(result).toEqual({ ok: true, value: expected });
    }
  });
}

describe("DATE, YEAR, MONTH, DAY", () => {
  table([
    ["DATE(2026, 3, 5)", "2026-03-05"],
    ["DATE(2024, 2, 29)", "2024-02-29"],
    ["DATE(2023, 2, 29)", { error: /not a real date/ }],
    ["DATE(2026, 13, 1)", { error: /not a real date/ }],
    ["DATE(2026, 4, 31)", { error: /not a real date/ }],
    ["DATE(0, 1, 1)", { error: /not a real date/ }],
    ["DATE(1900, 2, 29)", { error: /not a real date/ }],
    ["DATE(2000, 2, 29)", "2000-02-29"],
    ['DATE("x", 1, 1)', { error: /not a number/ }],
    ["YEAR('2026-03-05')", 2026],
    ["MONTH('2026-03-05')", 3],
    ["DAY('2026-03-05')", 5],
    ["DAY('2026-03-05T23:59:59')", 5],
    ["DAY('2026-03-05T23:30:00Z')", 5],
    ["DAY('2026-03-05T23:30:00-05:00')", 6],
    ["YEAR({{d}})", null, { d: "" }],
    ["YEAR({{missing}})", null],
    ["YEAR('05/03/2026')", { error: /ISO date/ }],
    ["YEAR('March 5 2026')", { error: /ISO date/ }],
    ["YEAR('2026-02-30')", { error: /ISO date/ }],
    ["YEAR('2026-3-5')", { error: /ISO date/ }],
    ["YEAR(2026)", { error: /ISO date/ }],
    ["MONTH('2026-03-05T25:00:00')", { error: /ISO date/ }],
    ["DAY('2026-03-05 10:00:00')", { error: /ISO date/ }],
  ]);
});

describe("DATEDIF", () => {
  table([
    ["DATEDIF('2026-01-01', '2026-03-05', 'D')", 63],
    ["DATEDIF('2026-03-05', '2026-03-05', 'D')", 0],
    ["DATEDIF('2024-02-28', '2024-03-01', 'D')", 2],
    ["DATEDIF('2023-02-28', '2023-03-01', 'D')", 1],
    ["DATEDIF('2000-01-01', '2026-01-01', 'D')", 9497],
    ["DATEDIF('2026-03-05', '2026-01-01', 'D')", -63],
    ["DATEDIF('2026-01-31', '2026-02-28', 'M')", 0],
    ["DATEDIF('2026-01-31', '2026-03-31', 'M')", 2],
    ["DATEDIF('2026-01-15', '2026-03-14', 'M')", 1],
    ["DATEDIF('2026-01-15', '2026-03-15', 'm')", 2],
    ["DATEDIF('2026-03-31', '2026-01-31', 'M')", -2],
    ["DATEDIF('2020-02-29', '2024-02-28', 'Y')", 3],
    ["DATEDIF('2020-02-29', '2024-02-29', 'Y')", 4],
    ["DATEDIF('2024-02-29', '2020-02-29', 'Y')", -4],
    ["DATEDIF('2026-03-05', {{blank}}, 'D')", null],
    ["DATEDIF('2026-03-05', '2026-03-06', 'W')", { error: /unit/ }],
    ["DATEDIF('nope', '2026-03-06', 'D')", { error: /ISO date/ }],
    ["DATEDIF('2026-03-05T00:00:00Z', '2026-03-06T00:00:00Z', 'D')", 1],
  ]);
});

describe("TEXT with a format", () => {
  table([
    ["TEXT('2026-03-05', 'yyyy-mm-dd')", "2026-03-05"],
    ["TEXT('2026-03-05', 'dd/mm/yyyy')", "05/03/2026"],
    ["TEXT('2026-03-05', 'mmm d, yyyy')", "Mar 5, 2026"],
    ["TEXT('2026-12-25', 'mmmm d, yyyy')", "December 25, 2026"],
    ["TEXT('2026-03-05', 'YYYY-MM-DD')", "2026-03-05"],
    ["TEXT('2026-03-05', 'yy.m.d')", "26.3.5"],
    ["TEXT({{d}}, 'yyyy-mm-dd')", "", { d: "" }],
    ["TEXT('hello', 'yyyy-mm-dd')", { error: /ISO date/ }],
    ["TEXT(1234.5, '0.00')", "1234.50"],
    ["TEXT(1234.5, '#,##0')", "1,235"],
    ["TEXT(1234567.891, '#,##0.00')", "1,234,567.89"],
    ["TEXT(-1234.5, '#,##0.0')", "-1,234.5"],
    ["TEXT(0.005, '0.00')", "0.01"],
    ["TEXT(1.005, '0.00')", "1.01"],
    ["TEXT(-0.001, '0.00')", "0.00"],
    ["TEXT(7, '0')", "7"],
    ["TEXT(999, '#,##0')", "999"],
    ["TEXT({{n}}, '0.00')", "", { n: null }],
    ["TEXT('abc', '0.00')", { error: /not a number/ }],
    ["TEXT(5, 'hh:mm')", { error: /does not support the format/ }],
    ["TEXT(5, '$#,##0')", { error: /does not support the format/ }],
    ["TEXT(5)", "5"],
    ["TEXT(true)", "true"],
  ]);
});

describe("JSON_VALUE", () => {
  const json = JSON.stringify({ name: "Ada", score: 7.5, ok: true, nothing: null, tags: ["a", "b"], company: { size: 12, geo: { city: "Seoul" } }, list: [{ id: 1 }, { id: 2 }], "weird key": 1 });
  table([
    ['JSON_VALUE({{j}}, "name")', "Ada", { j: json }],
    ['JSON_VALUE({{j}}, "score")', 7.5, { j: json }],
    ['JSON_VALUE({{j}}, "ok")', true, { j: json }],
    ['JSON_VALUE({{j}}, "nothing")', null, { j: json }],
    ['JSON_VALUE({{j}}, "company.geo.city")', "Seoul", { j: json }],
    ['JSON_VALUE({{j}}, "tags[1]")', "b", { j: json }],
    ['JSON_VALUE({{j}}, "list[1].id")', 2, { j: json }],
    ['JSON_VALUE({{j}}, "$.company.size")', 12, { j: json }],
    ['JSON_VALUE({{j}}, "tags")', ["a", "b"], { j: json }],
    ['JSON_VALUE({{j}}, "company.geo")', '{"city":"Seoul"}', { j: json }],
    ['JSON_VALUE({{j}}, "")', JSON.stringify(JSON.parse(json)), { j: json }],
    ['JSON_VALUE({{j}}, "missing")', null, { j: json }],
    ['JSON_VALUE({{j}}, "company.missing.deeper")', null, { j: json }],
    ['JSON_VALUE({{j}}, "tags[9]")', null, { j: json }],
    ['JSON_VALUE({{j}}, "name[0]")', null, { j: json }],
    ['JSON_VALUE({{j}}, "tags.x")', null, { j: json }],
    ['JSON_VALUE({{j}}, "constructor")', null, { j: json }],
    ['JSON_VALUE({{j}}, "__proto__")', null, { j: json }],
    ['JSON_VALUE({{j}}, "name.length")', null, { j: json }],
    ['JSON_VALUE({{j}}, "a..b")', { error: /empty part/ }, { j: json }],
    ['JSON_VALUE({{j}}, "a.")', { error: /empty part/ }, { j: json }],
    ['JSON_VALUE({{j}}, "tags[x]")', { error: /index/ }, { j: json }],
    ['JSON_VALUE({{j}}, "tags[1")', { error: /index/ }, { j: json }],
    ['JSON_VALUE("not json", "a")', { error: /needs JSON text/ }],
    ['JSON_VALUE("{broken", "a")', { error: /needs JSON text/ }],
    ['JSON_VALUE("", "a")', null],
    ["JSON_VALUE({{j}}, 'a')", null, { j: null }],
    ['JSON_VALUE("[1,2,3]", "[2]")', 3],
    ['JSON_VALUE("42", "")', 42],
    ['JSON_VALUE({{j}}, "[1]")', "y", { j: ["x", "y"] }],
    ['JSON_VALUE({{j}}, "a")', 1, { j: { a: 1 } }],
  ]);

  it("refuses a path with too many parts", () => {
    const path = Array.from({ length: FORMULA_LIMITS.maxJsonPathSegments + 1 }, () => "a").join(".");
    const result = run(`JSON_VALUE("{}", "${path}")`);
    expect(result.ok).toBe(false);
  });
});

describe("INDEX", () => {
  table([
    ["INDEX([10, 20, 30], 2)", 20],
    ["INDEX([10, 20, 30], 1)", 10],
    ["INDEX([10, 20, 30], 4)", null],
    ["INDEX([10, 20, 30], 0)", { error: /whole number from 1/ }],
    ["INDEX([10, 20, 30], -1)", { error: /whole number from 1/ }],
    ["INDEX([10, 20, 30], 1.5)", { error: /whole number from 1/ }],
    ["INDEX('abc', 1)", { error: /needs a list/ }],
    ["INDEX(SPLIT('a,b,c', ','), 3)", "c"],
    ["INDEX([], 1)", null],
  ]);
});

describe("IFS, SWITCH, ISERROR, IFERROR", () => {
  table([
    ["IFS({{n}} > 10, 'big', {{n}} > 5, 'mid', TRUE, 'small')", "mid", { n: 7 }],
    ["IFS({{n}} > 10, 'big', {{n}} > 5, 'mid', TRUE, 'small')", "small", { n: 1 }],
    ["IFS(false, 1, true, 2, true, 3)", 2],
    ["IFS(false, 1)", { error: /no true test/ }],
    ["IFS(true, 1, false)", { error: /pairs/ }],
    ["IFS(true, 1, 1 / 0, 2)", 1],
    ["IFS(false, 1 / 0, true, 2)", 2],
    ["SWITCH({{s}}, 'a', 1, 'b', 2, 99)", 2, { s: "b" }],
    ["SWITCH({{s}}, 'a', 1, 'b', 2, 99)", 99, { s: "z" }],
    ["SWITCH({{s}}, 'a', 1, 'b', 2)", { error: /no matching case/ }, { s: "z" }],
    ["SWITCH(5, '5', 'five', 'x')", "five"],
    ["SWITCH(1, 1, 'a', 1 / 0, 'b')", "a"],
    ["SWITCH({{s}}, '', 'blank', 'other')", "blank", { s: "" }],
    ["SWITCH(1, 2)", { error: /takes 3 to 32 arguments/ }],
    ["ISERROR(1 / 0)", true],
    ["ISERROR(1 / 1)", false],
    ["ISERROR('x' * 2)", true],
    ["ISERROR(DATE(2023, 2, 30))", true],
    ["ISERROR(NOSUCH(1))", true],
    ["IFERROR(1 / 0, 'fallback')", "fallback"],
    ["IFERROR(JSON_VALUE('nope', 'a'), 'none')", "none"],
    ["IFERROR(DATEDIF('bad', '2026-01-01', 'D'), -1)", -1],
  ]);

  it("handles IFS nested 20 levels deep", () => {
    let expression = "'bottom'";
    for (let i = 0; i < 20; i += 1) expression = `IFS(false, 0, true, ${expression})`;
    expect(run(expression)).toEqual({ ok: true, value: "bottom" });
  });

  it("stops IFS nesting at the depth limit instead of recursing", () => {
    let expression = "1";
    for (let i = 0; i < FORMULA_LIMITS.maxDepth + 5; i += 1) expression = `IFS(true, ${expression})`;
    expect(run(expression).ok).toBe(false);
  });

  it("accepts IFS with the maximum number of arguments and refuses one more", () => {
    const pairs = (n: number) => Array.from({ length: n }, (_, i) => `${i === n - 1 ? "true" : "false"}, ${i}`).join(", ");
    expect(run(`IFS(${pairs(FORMULA_LIMITS.maxArgs / 2)})`)).toEqual({ ok: true, value: FORMULA_LIMITS.maxArgs / 2 - 1 });
    expect(compileFormula(`IFS(${pairs(FORMULA_LIMITS.maxArgs / 2 + 1)})`).ok).toBe(false);
  });
});

describe("ROUNDUP and ROUNDDOWN", () => {
  table([
    ["ROUNDUP(2.1)", 3],
    ["ROUNDUP(2.0)", 2],
    ["ROUNDUP(-2.1)", -3],
    ["ROUNDUP(3.14159, 2)", 3.15],
    ["ROUNDUP(1.1, 1)", 1.1],
    ["ROUNDUP(0.1 + 0.2, 1)", 0.3],
    ["ROUNDUP(1234, -2)", 1300],
    ["ROUNDDOWN(2.9)", 2],
    ["ROUNDDOWN(-2.9)", -2],
    ["ROUNDDOWN(3.14159, 2)", 3.14],
    ["ROUNDDOWN(1999, -3)", 1000],
    ["ROUNDDOWN(0, 2)", 0],
    ["ROUNDDOWN(1.1 * 100, 0)", 110],
    ["ROUNDUP('abc')", { error: /not a number/ }],
    ["ROUNDUP(1, 2, 3)", { error: /takes 1 to 2 arguments/ }],
  ]);
});

describe("argument counts", () => {
  table([
    ["TODAY(1)", { error: /takes 0 arguments/ }],
    ["NOW(1)", { error: /takes 0 arguments/ }],
    ["DATE(2026, 1)", { error: /takes 3 arguments/ }],
    ["YEAR()", { error: /takes 1 argument/ }],
    ["DATEDIF('2026-01-01', '2026-01-02')", { error: /takes 3 arguments/ }],
    ["JSON_VALUE('{}')", { error: /takes 2 arguments/ }],
    ["INDEX([1])", { error: /takes 2 arguments/ }],
    ["IFS(true)", { error: /takes 2 to 32 arguments/ }],
  ]);
});

describe("TODAY and NOW", () => {
  const at = (iso: string, timeZone: string, expression: string) => run(expression, {}, { now: new Date(iso), timeZone });

  it("returns the date in the organization zone around midnight", () => {
    // 2026-03-05 15:30 UTC is 2026-03-06 00:30 in Seoul (+09:00) and 2026-03-05 07:30 in Los Angeles (-08:00).
    const instant = "2026-03-05T15:30:00Z";
    expect(at(instant, "Asia/Seoul", "TODAY()")).toEqual({ ok: true, value: "2026-03-06" });
    expect(at(instant, "America/Los_Angeles", "TODAY()")).toEqual({ ok: true, value: "2026-03-05" });
    expect(at(instant, "UTC", "TODAY()")).toEqual({ ok: true, value: "2026-03-05" });
  });

  it("flips at local midnight, not UTC midnight", () => {
    expect(at("2026-03-05T14:59:59Z", "Asia/Seoul", "TODAY()")).toEqual({ ok: true, value: "2026-03-05" });
    expect(at("2026-03-05T15:00:00Z", "Asia/Seoul", "TODAY()")).toEqual({ ok: true, value: "2026-03-06" });
    expect(at("2026-03-06T07:59:59Z", "America/Los_Angeles", "TODAY()")).toEqual({ ok: true, value: "2026-03-05" });
    expect(at("2026-03-06T08:00:00Z", "America/Los_Angeles", "TODAY()")).toEqual({ ok: true, value: "2026-03-06" });
  });

  it("follows daylight saving time", () => {
    // Los Angeles is -07:00 after 2026-03-08 10:00 UTC.
    expect(at("2026-03-08T06:30:00Z", "America/Los_Angeles", "NOW()")).toEqual({ ok: true, value: "2026-03-07T22:30:00-08:00" });
    expect(at("2026-03-08T10:30:00Z", "America/Los_Angeles", "NOW()")).toEqual({ ok: true, value: "2026-03-08T03:30:00-07:00" });
  });

  it("writes NOW with the zone offset", () => {
    expect(at("2026-03-05T15:30:45Z", "Asia/Seoul", "NOW()")).toEqual({ ok: true, value: "2026-03-06T00:30:45+09:00" });
    expect(at("2026-03-05T15:30:45Z", "UTC", "NOW()")).toEqual({ ok: true, value: "2026-03-05T15:30:45Z" });
    expect(at("2026-03-05T15:30:45Z", "Asia/Kolkata", "NOW()")).toEqual({ ok: true, value: "2026-03-05T21:00:45+05:30" });
  });

  it("reads an offset timestamp as the day it falls on in the organization zone", () => {
    expect(at("2026-03-05T00:00:00Z", "Asia/Seoul", "DAY('2026-03-05T20:00:00Z')")).toEqual({ ok: true, value: 6 });
    expect(at("2026-03-05T00:00:00Z", "America/Los_Angeles", "DAY('2026-03-05T05:00:00Z')")).toEqual({ ok: true, value: 4 });
  });

  it("computes days since a date using the zone's today", () => {
    expect(at("2026-03-05T15:30:00Z", "Asia/Seoul", "DATEDIF('2026-03-01', TODAY(), 'D')")).toEqual({ ok: true, value: 5 });
    expect(at("2026-03-05T15:30:00Z", "America/Los_Angeles", "DATEDIF('2026-03-01', TODAY(), 'D')")).toEqual({ ok: true, value: 4 });
  });

  it("round-trips through TEXT", () => {
    expect(at("2026-03-05T15:30:00Z", "Asia/Seoul", "TEXT(TODAY(), 'mmm d, yyyy')")).toEqual({ ok: true, value: "Mar 6, 2026" });
    expect(at("2026-03-05T15:30:00Z", "Asia/Seoul", "TEXT(NOW(), 'yyyy-mm-dd')")).toEqual({ ok: true, value: "2026-03-06" });
  });

  it("rejects an unknown zone and a missing clock", () => {
    expect(at("2026-03-05T00:00:00Z", "Mars/Olympus", "TODAY()")).toMatchObject({ ok: false, error: expect.stringMatching(/not a known time zone/) });
    expect(evaluateFormula("TODAY()", {}, {})).toMatchObject({ ok: false, error: expect.stringMatching(/needs the current time/) });
    expect(evaluateFormula("NOW()", {}, { timeZone: "UTC" })).toMatchObject({ ok: false });
  });

  it("gives the same answer for the same instant, so evaluation is deterministic", () => {
    const a = at("2026-03-05T15:30:00Z", "Asia/Seoul", "NOW()");
    const b = at("2026-03-05T15:30:00Z", "Asia/Seoul", "NOW()");
    expect(a).toEqual(b);
  });
});

describe("volatile marking", () => {
  const refs = (expression: string) => referencesOf(parseFormula(expression));

  it("marks TODAY and NOW as volatile, including inside other calls", () => {
    expect(refs("TODAY()").volatile).toBe(true);
    expect(refs("NOW()").volatile).toBe(true);
    expect(refs("IF({{a}}, DATEDIF({{d}}, TODAY(), 'D'), 0)").volatile).toBe(true);
    expect(refs("[1, NOW()]").volatile).toBe(true);
  });

  it("does not mark other date functions or plain formulas", () => {
    expect(refs("DATEDIF({{a}}, {{b}}, 'D')").volatile).toBe(false);
    expect(refs("DATE(2026, 1, 1)").volatile).toBe(false);
    expect(refs("UPPER({{a}})").volatile).toBe(false);
    expect(refs("'TODAY()'").volatile).toBe(false);
  });

  it("flags date functions so the caller loads the time zone", () => {
    expect(refs("YEAR({{a}})").usesDates).toBe(true);
    expect(refs("UPPER({{a}})").usesDates).toBe(false);
  });

  it("flags TEXT as a date function only when it has a format argument", () => {
    expect(refs("TEXT({{n}})").usesDates).toBe(false);
    expect(refs("TEXT({{d}}, 'yyyy-mm-dd')").usesDates).toBe(true);
    expect(refs("UPPER(TEXT({{n}}))").usesDates).toBe(false);
  });
});

describe("the engine stays closed", () => {
  const rejects = (expression: string, message: RegExp) => {
    const result = run(expression);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(message);
  };

  it("still rejects property access and unknown names", () => {
    rejects("'abc'.length", /Property access is not supported/);
    rejects("{{a}}.constructor", /Property access is not supported/);
    rejects("constructor", /not a function or value/);
    rejects("process", /not a function or value/);
    rejects("globalThis", /not a function or value/);
    rejects("constructor('return 1')()", /Unknown function CONSTRUCTOR|Unexpected/);
    rejects("TODAY", /not a function or value/);
    rejects("JSON_VALUE.call()", /Property access is not supported/);
  });

  it("keeps unknown functions unknown, including the regex and conditional-count ones that stay out", () => {
    for (const name of ["REGEXMATCH", "REGEXEXTRACT", "REGEXREPLACE", "COUNTIF", "SUMIF", "EVAL", "FUNCTION", "RAND", "VLOOKUP"]) {
      rejects(`${name}('a', 'b')`, new RegExp(`Unknown function ${name}`));
    }
  });
});

describe("TEXT pattern cost", () => {
  const huge = "y".repeat(100_000);

  it("rejects a 100k-character pattern with an ERROR", () => {
    const result = run("TEXT('2026-03-05', {{p}})", { p: huge });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("ERROR");
      expect(result.error).toMatch(/at most 64 characters/);
    }
  });

  it("accepts a pattern of exactly 64 characters", () => {
    const result = run("TEXT('2026-03-05', {{p}})", { p: "y".repeat(64) });
    expect(result.ok).toBe(true);
  });

  it("charges steps by pattern length, so repeated huge patterns hit the step budget", () => {
    const call = "IFERROR(TEXT('2026-03-05', {{p}}), 0)";
    const formula = Array.from({ length: 70 }, () => call).join(" + ");
    const result = run(formula, { p: huge });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/too much work/);
  });
});

describe("ISERROR and IFERROR catch data errors only", () => {
  const manyHeavyTerms = `SUM(${Array.from({ length: 10 }, () => "SEQUENCE(10000)").join(", ")})`;

  it("lets the step-budget error pass through both functions", () => {
    for (const wrap of [(e: string) => `ISERROR(${e})`, (e: string) => `IFERROR(${e}, 'fallback')`]) {
      const result = run(wrap(manyHeavyTerms));
      expect(result.ok, wrap(manyHeavyTerms)).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/too much work/);
    }
  });
  it("lets the text length guard pass through", () => {
    const result = run("ISERROR(REPEAT('abcdefghij', 20000))");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/Text longer than/);
    expect(run("IFERROR(REPEAT('abcdefghij', 20000), 'x')").ok).toBe(false);
  });
  it("lets the missing-clock error pass through", () => {
    const iserror = run("ISERROR(TODAY())", {}, {});
    expect(iserror.ok).toBe(false);
    if (!iserror.ok) expect(iserror.error).toMatch(/needs the current time/);
    expect(run("IFERROR(NOW(), 'x')", {}, {}).ok).toBe(false);
  });
  it("still catches data errors", () => {
    expect(run("ISERROR(1 / 0)")).toEqual({ ok: true, value: true });
    expect(run("ISERROR(DATE(2023, 2, 30))")).toEqual({ ok: true, value: true });
    expect(run("ISERROR(JSON_VALUE('{\"a\":1}', 'a..b'))")).toEqual({ ok: true, value: true });
    expect(run("IFERROR(1 / 0, 'n/a')")).toEqual({ ok: true, value: "n/a" });
    expect(run("IFERROR(DATEDIF('bad', '2026-01-01', 'D'), -1)")).toEqual({ ok: true, value: -1 });
    expect(run("IFERROR(JSON_VALUE('nope', 'a'), 'none')")).toEqual({ ok: true, value: "none" });
  });
});
