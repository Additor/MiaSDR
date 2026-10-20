import { describe, expect, it } from "vitest";
import { CsvError, parseCsv } from "../csv";

describe("parseCsv", () => {
  it("reads a semicolon file", () => {
    const parsed = parseCsv(Buffer.from("email;name\na@x.com;A\n"));
    expect(parsed.rows).toEqual([{ email: "a@x.com", name: "A" }]);
  });

  it("keeps a stray quote inside an unquoted field", () => {
    const parsed = parseCsv(Buffer.from('email,name\na@x.com,=HYPERLINK("u")\n'));
    expect(parsed.rows[0].name).toBe('=HYPERLINK("u")');
  });

  it("rejects binary content", () => {
    expect(() => parseCsv(Buffer.from([0, 1, 2, 103, 97, 114, 98]))).toThrow(CsvError);
  });

  it("rejects a header with no data rows", () => {
    expect(() => parseCsv(Buffer.from("email,name\n"))).toThrow(/no leads/);
  });
});
