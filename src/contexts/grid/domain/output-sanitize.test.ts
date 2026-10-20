import { describe, expect, it } from "vitest";
import { MAX_OUTPUT_STRING_CHARS, sanitizeOutput, sanitizeOutputString } from "./output-sanitize";

describe("sanitizeOutputString", () => {
  it("strips NUL and control characters but keeps tab and newline", () => {
    expect(sanitizeOutputString("a\u0000b\u0007c\td\ne\u007Ff\u0085g")).toBe("abc\td\nefg");
  });

  it("turns CRLF into a newline and drops a lone carriage return", () => {
    expect(sanitizeOutputString("a\r\nb\rc")).toBe("a\nb\nc");
  });

  it("replaces lone surrogates and keeps valid pairs", () => {
    expect(sanitizeOutputString("x\uD800y\uDC00z")).toBe("x�y�z");
    expect(sanitizeOutputString("ok \u{1F600}")).toBe("ok \u{1F600}");
  });

  it("caps the length without leaving half a surrogate pair", () => {
    const out = sanitizeOutputString("\u{1F600}".repeat(10), 3);
    expect(out.length).toBeLessThanOrEqual(3);
    expect(JSON.parse(JSON.stringify(out))).toBe(out);
    expect(sanitizeOutputString("a".repeat(MAX_OUTPUT_STRING_CHARS + 50))).toHaveLength(MAX_OUTPUT_STRING_CHARS);
  });
});

describe("sanitizeOutput", () => {
  it("cleans nested strings and keys", () => {
    const out = sanitizeOutput({ "k\u0000ey": ["a\u0000", { deep: "b\u0001c" }], n: 1, ok: true, nothing: null });
    expect(out).toEqual({ key: ["a", { deep: "bc" }], n: 1, ok: true, nothing: null });
  });

  it("turns numbers JSON cannot hold into null and bounds depth and width", () => {
    expect(sanitizeOutput({ a: Number.NaN, b: Infinity })).toEqual({ a: null, b: null });
    let deep: unknown = "end";
    for (let i = 0; i < 40; i++) deep = { next: deep };
    expect(JSON.stringify(sanitizeOutput(deep)).length).toBeLessThan(400);
    expect(sanitizeOutput(Array.from({ length: 5000 }, (_, i) => i))).toHaveLength(1000);
  });

  it("produces text Postgres accepts in jsonb", () => {
    const out = JSON.stringify(sanitizeOutput({ a: "x\u0000\uD800" }));
    expect(out).not.toContain("\\u0000");
    expect(out).not.toMatch(/\\ud800/i);
  });
});
