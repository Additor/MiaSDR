import { describe, expect, it } from "vitest";
import { coerceAiOutput, MAX_AI_JSON_CHARS, MAX_AI_TEXT_CHARS } from "./ai-output-coerce";

const ok = (type: string, raw: unknown) => {
  const r = coerceAiOutput(type, raw);
  if (!r.ok) throw new Error(r.message);
  return r.value;
};
const bad = (type: string, raw: unknown) => {
  const r = coerceAiOutput(type, raw);
  return r.ok ? null : r.message;
};

describe("coerceAiOutput", () => {
  it("stores an empty cell for null, undefined and blank text in every type", () => {
    for (const type of ["text", "number", "boolean", "email", "url", "date", "json"]) {
      expect(ok(type, null)).toBeNull();
      expect(ok(type, undefined)).toBeNull();
      expect(ok(type, "   ")).toBeNull();
    }
  });

  it("accepts an email, trims it, and rejects text that is not an address", () => {
    expect(ok("email", "  ann@acme.test ")).toBe("ann@acme.test");
    for (const v of ["ann", "ann@acme", "ann @acme.test", "Ann <ann@acme.test>", "a@b.c", "mailto:ann@acme.test", 42]) expect(bad("email", v), String(v)).toContain("not an email");
    expect(bad("email", `${"a".repeat(250)}@acme.test`)).not.toBeNull();
  });

  it("rejects emails with doubled dots, a formula lead or control characters", () => {
    for (const v of ["a..b@acme.test", "=cmd@acme.test", "+ann@acme.test", "-ann@acme.test", "@ann@acme.test", "ann\u0007@acme.test", "ann\u0000@acme.test", "a\nb@acme.test"]) {
      expect(bad("email", v), JSON.stringify(v)).toContain("not an email");
    }
    expect(ok("email", "ann.b@acme.test")).toBe("ann.b@acme.test");
  });

  it("accepts http and https URLs with a dotted host only", () => {
    expect(ok("url", "https://acme.test/a?b=1")).toBe("https://acme.test/a?b=1");
    for (const v of ["acme.test", "ftp://acme.test", "javascript:alert(1)", "https://localhost", "not a url", 7]) expect(bad("url", v), String(v)).not.toBeNull();
    expect(bad("url", `https://acme.test/${"a".repeat(2100)}`)).toContain("too long");
    for (const v of ["https://acme.test/a b", "https://acme.test/\nx", "https://acme.test/\u0000", "https://acme.test/a\tb"]) expect(bad("url", v), JSON.stringify(v)).toContain("not a URL");
  });

  it("accepts a real calendar date and cuts an ISO timestamp to its date", () => {
    expect(ok("date", "2026-02-28")).toBe("2026-02-28");
    expect(ok("date", "2026-02-28T10:00:00Z")).toBe("2026-02-28");
    for (const v of ["2026-02-30", "2026-13-01", "next Tuesday", "28/02/2026", "2026-2-8"]) expect(bad("date", v), v).toContain("not a date");
    expect(ok("date", "2024-02-29")).toBe("2024-02-29");
    expect(bad("date", "2025-02-29")).not.toBeNull();
    expect(ok("date", "2026-02-28 10:00")).toBe("2026-02-28");
    expect(ok("date", "2026-02-28T10:00:00.123+09:00")).toBe("2026-02-28");
    for (const v of ["2026-02-28T::", "2026-02-28 ...", "2026-02-28T10:00:00Zjunk", "2026-02-28T25:00", "2026-02-28T10:61", "2026-02-28T"]) expect(bad("date", v), v).toContain("not a date");
  });

  it("parses JSON text and stores the parsed value; caps the size", () => {
    expect(ok("json", '{"a":[1,2]}')).toEqual({ a: [1, 2] });
    expect(ok("json", "[1]")).toEqual([1]);
    expect(ok("json", "null")).toBeNull();
    expect(bad("json", "{oops")).toContain("not valid JSON");
    for (const v of ["5", '"text"', "true", "-1.5"]) expect(bad("json", v), v).toContain("object or a list");
    expect(bad("json", 5)).not.toBeNull();
    expect(bad("json", `"${"x".repeat(MAX_AI_JSON_CHARS)}"`)).toContain("longer than");
    expect(bad("json", JSON.stringify({ k: "y".repeat(MAX_AI_JSON_CHARS) }))).toContain("longer than");
  });

  it("keeps numbers and booleans strict", () => {
    expect(ok("number", 3.5)).toBe(3.5);
    expect(bad("number", "3")).not.toBeNull();
    expect(bad("number", Number.NaN)).not.toBeNull();
    expect(ok("boolean", false)).toBe(false);
    expect(bad("boolean", "yes")).not.toBeNull();
  });

  it("passes text through", () => {
    expect(ok("text", "hello")).toBe("hello");
    expect(ok("text", "x".repeat(MAX_AI_TEXT_CHARS))).toHaveLength(MAX_AI_TEXT_CHARS);
    expect(bad("text", "x".repeat(MAX_AI_TEXT_CHARS + 1))).toContain("longer than");
  });
});
