import { strToU8, unzipSync, zipSync } from "fflate";
import { makeXlsx, type Cell } from "@/test-support/xlsx-fixture";
import { describe, expect, it } from "vitest";
import { CsvError } from "../csv";
import { parseSpreadsheet } from "../spreadsheet";
import { MAX_SHEETS, MAX_WORKBOOK_XML_BYTES, parseXlsx, SheetContentError, sheetNames } from "../xlsx";

const asBuffer = (bytes: Uint8Array) => Buffer.from(bytes);

describe("parseXlsx", () => {
  it("reads headers and rows from the first sheet, Korean included", async () => {
    const bytes = makeXlsx(
      [
        ["Email", "Name", "회사 규모"],
        ["a@acme.com", "Ada Kim", "51-200"],
        ["b@acme.com", "Bo 이", 40],
      ],
      { secondSheet: [["Email"], ["other@x.com"]] },
    );
    const parsed = await parseXlsx(asBuffer(bytes));
    expect(parsed.headers).toEqual(["Email", "Name", "회사 규모"]);
    expect(parsed.rows).toEqual([
      { Email: "a@acme.com", Name: "Ada Kim", "회사 규모": "51-200" },
      { Email: "b@acme.com", Name: "Bo 이", "회사 규모": "40" },
    ]);
  });

  it("keeps a formula as its cached text and never evaluates it", async () => {
    const parsed = await parseXlsx(asBuffer(makeXlsx([["Email", "Note"], ["a@acme.com", { formula: 'HYPERLINK("http://evil.test","x")', cached: "cached text" }]])));
    expect(parsed.rows[0].Note).toBe("cached text");
  });

  it("keeps a cell that starts with = as plain text", async () => {
    const parsed = await parseXlsx(asBuffer(makeXlsx([["Email", "Note"], ["a@acme.com", "=cmd|' /C calc'!A0"]])));
    expect(parsed.rows[0].Note).toBe("=cmd|' /C calc'!A0");
  });

  it("makes repeated headers unique and skips blank rows", async () => {
    const parsed = await parseXlsx(asBuffer(makeXlsx([["Email", "Email"], ["a@acme.com", "b@acme.com"], ["", ""], ["c@acme.com", ""]])));
    expect(parsed.headers).toEqual(["Email", "Email (2)"]);
    expect(parsed.rows).toHaveLength(2);
  });

  it("rejects a workbook that carries a macro project", async () => {
    const bytes = makeXlsx([["Email"], ["a@acme.com"]], { extra: { "xl/vbaProject.bin": strToU8("MACRO") } });
    await expect(parseXlsx(asBuffer(bytes))).rejects.toThrow(/macros/);
  });

  it("rejects a macro-enabled content type", async () => {
    const bytes = makeXlsx([["Email"], ["a@acme.com"]], {
      contentTypes: `<Types><Override PartName="/xl/workbook.xml" ContentType="application/vnd.ms-excel.sheet.macroEnabled.main+xml"/></Types>`,
    });
    await expect(parseXlsx(asBuffer(bytes))).rejects.toThrow(/macros/);
  });

  it("rejects .xlsm and .xlsb by name", async () => {
    const bytes = asBuffer(makeXlsx([["Email"], ["a@acme.com"]]));
    await expect(parseSpreadsheet(bytes, "leads.xlsm")).rejects.toThrow(/macros/);
  });

  it("rejects a zip bomb by declared size", async () => {
    const huge = new Uint8Array(80 * 1024 * 1024);
    const bytes = makeXlsx([["Email"], ["a@acme.com"]], { extra: { "xl/worksheets/sheet9.xml": huge } });
    expect(bytes.byteLength).toBeLessThan(5 * 1024 * 1024);
    await expect(parseXlsx(asBuffer(bytes))).rejects.toThrow(/too large once unpacked/);
  });

  it("keeps inflating bounded when a part declares less than it holds", async () => {
    const bytes = makeXlsx([["Email"], ["a@acme.com"]], { extra: { "xl/worksheets/sheet9.xml": new Uint8Array(80 * 1024 * 1024) } });
    // Overwrite every central-directory "uncompressed size" of sheet9 with 10 bytes.
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const name = strToU8("xl/worksheets/sheet9.xml");
    for (let i = 0; i < bytes.length - 46; i += 1) {
      if (view.getUint32(i, true) === 0x02014b50 && bytes.subarray(i + 46, i + 46 + name.length).every((b, k) => b === name[k])) {
        view.setUint32(i + 24, 10, true);
      }
    }
    // fflate inflates into a buffer of the declared size and cuts the rest off, so 80 MB is never allocated.
    const parsed = await parseXlsx(asBuffer(bytes));
    expect(parsed.rows).toEqual([{ Email: "a@acme.com" }]);
  });

  it("rejects an oversized upload", async () => {
    await expect(parseXlsx(Buffer.alloc(5 * 1024 * 1024 + 1))).rejects.toThrow(/larger than 5 MB/);
  });

  it("rejects more than the row limit", async () => {
    const rows: Cell[][] = [["Email"]];
    for (let i = 0; i < 11_500; i += 1) rows.push([`u${i}@acme.com`]);
    await expect(parseXlsx(asBuffer(makeXlsx(rows)))).rejects.toThrow(/limit is 10000/);
  });

  it("rejects a cell longer than the cap", async () => {
    await expect(parseXlsx(asBuffer(makeXlsx([["Email", "Note"], ["a@acme.com", "x".repeat(5_001)]])))).rejects.toThrow(/longer than 5000/);
  });

  it("rejects an old .xls and non-zip content", async () => {
    await expect(parseXlsx(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0, 0, 0, 0]))).rejects.toThrow(/old \.xls|password/);
    await expect(parseXlsx(Buffer.from("a,b\n1,2"))).rejects.toThrow(/not an \.xlsx/);
  });

  it("rejects a zip that is not a workbook", async () => {
    await expect(parseXlsx(asBuffer(zipSync({ "hello.txt": strToU8("hi") })))).rejects.toThrow(/not an Excel workbook/);
  });

  it("rejects a corrupt archive", async () => {
    const bytes = makeXlsx([["Email"], ["a@acme.com"]]);
    await expect(parseXlsx(asBuffer(bytes.subarray(0, Math.floor(bytes.length / 2))))).rejects.toBeInstanceOf(CsvError);
  });
});

describe("parseSpreadsheet", () => {
  it("sends CSV text to the CSV parser and workbooks to the XLSX parser", async () => {
    const csv = await parseSpreadsheet(Buffer.from("Email,Name\na@acme.com,Ada\n"), "leads.csv");
    expect(csv.rows).toEqual([{ Email: "a@acme.com", Name: "Ada" }]);
    const xlsx = await parseSpreadsheet(asBuffer(makeXlsx([["Email"], ["a@acme.com"]])), "renamed.csv");
    expect(xlsx.rows).toEqual([{ Email: "a@acme.com" }]);
  });
});

describe("sheet selection", () => {
  const threeSheets = () =>
    makeXlsx([["Email", "Name"], ["one@acme.com", "Ada"]], {
      secondSheet: [["Company", "회사 규모"], ["Acme", "51-200"], ["Globex", "1-10"]],
      secondName: "Companies &amp; 회사",
      moreSheets: [{ name: "Notes", rows: [["Note"], ["third"]] }],
    });

  it("reads sheet 1 by default and lists the three sheet names", async () => {
    const parsed = await parseXlsx(asBuffer(threeSheets()));
    expect(parsed.sheet).toBe(1);
    expect(parsed.sheets).toEqual(["Leads", "Companies & 회사", "Notes"]);
    expect(parsed.headers).toEqual(["Email", "Name"]);
    expect(parsed.rows).toEqual([{ Email: "one@acme.com", Name: "Ada" }]);
  });

  it("reads the sheet that was asked for", async () => {
    const second = await parseXlsx(asBuffer(threeSheets()), { sheet: 2 });
    expect(second.sheet).toBe(2);
    expect(second.headers).toEqual(["Company", "회사 규모"]);
    expect(second.rows).toHaveLength(2);
    const third = await parseXlsx(asBuffer(threeSheets()), { sheet: 3 });
    expect(third.headers).toEqual(["Note"]);
    expect(third.rows).toEqual([{ Note: "third" }]);
  });

  it("keeps sheet 1 for the leads importer, which passes no sheet", async () => {
    const parsed = await parseSpreadsheet(asBuffer(threeSheets()), "leads.xlsx");
    expect(parsed.headers).toEqual(["Email", "Name"]);
  });

  it("refuses a sheet number outside the workbook and says how many there are", async () => {
    await expect(parseXlsx(asBuffer(threeSheets()), { sheet: 4 })).rejects.toThrow(/3 sheets/);
    await expect(parseXlsx(asBuffer(threeSheets()), { sheet: 0 })).rejects.toBeInstanceOf(CsvError);
    await expect(parseXlsx(asBuffer(threeSheets()), { sheet: 1.5 })).rejects.toBeInstanceOf(CsvError);
  });

  it("reports an empty chosen sheet with the sheet list, so a picker can offer the others", async () => {
    const bytes = makeXlsx([["Email"], ["a@acme.com"]], { secondSheet: [] });
    const error = await parseXlsx(asBuffer(bytes), { sheet: 2 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SheetContentError);
    expect((error as SheetContentError).sheets).toEqual(["Leads", "Other"]);
    expect((error as SheetContentError).message).toBe('Sheet "Other" is empty.');
  });

  it("reads sheet names with entities, quotes and prefixes", () => {
    const xml = `<workbook><sheets><sheet name="A &amp; B" sheetId="1" r:id="rId1"/><x:sheet sheetId="2" name='It&apos;s' r:id="rId2"/><sheet name="&#xD55C;&#44544;" sheetId="3" r:id="rId3"/></sheets></workbook>`;
    expect(sheetNames(xml)).toEqual(["A & B", "It's", "한글"]);
  });
});

describe("hostile workbook.xml", () => {
  const withWorkbookXml = (xml: string) => {
    const files = unzipSync(makeXlsx([["Email"], ["a@acme.com"]]));
    files["xl/workbook.xml"] = strToU8(xml);
    return Buffer.from(zipSync(files));
  };

  it("scans 40,000 unterminated <sheet tags in linear time", () => {
    const xml = `<workbook><sheets>${"<sheet ".repeat(40_000)}`;
    const started = performance.now();
    expect(sheetNames(xml)).toEqual([]);
    expect(performance.now() - started).toBeLessThan(250);
  });

  it("rejects a workbook.xml over 1 MB before matching", () => {
    expect(() => sheetNames(`<workbook>${" ".repeat(MAX_WORKBOOK_XML_BYTES)}</workbook>`)).toThrow(CsvError);
    return expect(parseXlsx(withWorkbookXml(`<workbook>${"<sheet ".repeat(200_000)}</workbook>`))).rejects.toThrow(/workbook index is too large/);
  });

  it("rejects more than 255 sheets", async () => {
    const many = (n: number) => `<workbook><sheets>${Array.from({ length: n }, (_, i) => `<sheet name="S${i}" sheetId="${i + 1}" r:id="rId1"/>`).join("")}</sheets></workbook>`;
    expect(sheetNames(many(MAX_SHEETS))).toHaveLength(MAX_SHEETS);
    expect(() => sheetNames(many(MAX_SHEETS + 1))).toThrow(/more than 255 sheets/);
    await expect(parseXlsx(withWorkbookXml(many(3_000)))).rejects.toThrow(/more than 255 sheets/);
  });

  it("rejects a sheet name over 255 characters", () => {
    expect(() => sheetNames(`<workbook><sheets><sheet name="${"x".repeat(256)}" sheetId="1"/></sheets></workbook>`)).toThrow(/sheet name is longer than 255/);
    expect(sheetNames(`<workbook><sheets><sheet name="${"x".repeat(255)}" sheetId="1"/></sheets></workbook>`)).toHaveLength(1);
  });
});

describe("mislabeled files", () => {
  it("reads a real workbook saved with an .xls name by its content", async () => {
    const parsed = await parseSpreadsheet(asBuffer(makeXlsx([["Email"], ["a@acme.com"]])), "export.xls");
    expect(parsed.rows).toEqual([{ Email: "a@acme.com" }]);
  });

  it("explains an old binary .xls even when it is named .xlsx", async () => {
    const ole = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0]);
    await expect(parseSpreadsheet(ole, "leads.xlsx")).rejects.toThrow(/old \.xls file/);
    await expect(parseSpreadsheet(ole, "leads.xls")).rejects.toThrow(/Save it as \.xlsx or CSV/);
    await expect(parseSpreadsheet(ole, "leads.csv")).rejects.toThrow(/old \.xls file/);
  });

  it("refuses CSV text that carries an .xls name instead of guessing", async () => {
    await expect(parseSpreadsheet(Buffer.from("Email,Name\na@acme.com,Ada\n"), "leads.xls")).rejects.toThrow(/not an \.xlsx workbook/);
  });
});
