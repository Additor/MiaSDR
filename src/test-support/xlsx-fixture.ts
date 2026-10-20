import { strToU8, zipSync } from "fflate";

const colName = (i: number) => String.fromCharCode(65 + (i % 26)).repeat(Math.floor(i / 26) + 1);
const escapeXml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export type Cell = string | number | { formula: string; cached: string };

/** Builds a small .xlsx for tests: shared strings, numbers, cached formulas and up to three sheets. */
export function makeXlsx(
  rows: Cell[][],
  options: { contentTypes?: string; extra?: Record<string, Uint8Array>; secondSheet?: Cell[][]; moreSheets?: Array<{ name: string; rows: Cell[][] }>; secondName?: string } = {},
): Uint8Array {
  const shared: string[] = [];
  const sheetXml = (grid: Cell[][]) =>
    `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${grid
      .map(
        (row, r) =>
          `<row r="${r + 1}">${row
            .map((cell, c) => {
              const ref = `${colName(c)}${r + 1}`;
              if (typeof cell === "number") return `<c r="${ref}"><v>${cell}</v></c>`;
              if (typeof cell === "string") {
                shared.push(cell);
                return `<c r="${ref}" t="s"><v>${shared.length - 1}</v></c>`;
              }
              return `<c r="${ref}" t="str"><f>${escapeXml(cell.formula)}</f><v>${escapeXml(cell.cached)}</v></c>`;
            })
            .join("")}</row>`,
      )
      .join("")}</sheetData></worksheet>`;
  const sheet1 = sheetXml(rows);
  const sheet2 = options.secondSheet ? sheetXml(options.secondSheet) : null;
  // Sheets from the third on get rId4 and up; rId3 is the shared strings part.
  const more = (options.moreSheets ?? []).map((extra, i) => ({ ...extra, xml: sheetXml(extra.rows), n: i + 3, rel: `rId${i + 4}` }));
  const files: Record<string, Uint8Array> = {
    "[Content_Types].xml": strToU8(
      options.contentTypes ??
        `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>`,
    ),
    "_rels/.rels": strToU8(
      `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    ),
    "xl/workbook.xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Leads" sheetId="1" r:id="rId1"/>${sheet2 ? `<sheet name="${options.secondName ?? "Other"}" sheetId="2" r:id="rId2"/>` : ""}${more.map((x) => `<sheet name="${x.name}" sheetId="${x.n}" r:id="${x.rel}"/>`).join("")}</sheets></workbook>`,
    ),
    "xl/_rels/workbook.xml.rels": strToU8(
      `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>${sheet2 ? '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>' : ""}${more.map((x) => `<Relationship Id="${x.rel}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${x.n}.xml"/>`).join("")}<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>`,
    ),
    "xl/worksheets/sheet1.xml": strToU8(sheet1),
    ...(sheet2 ? { "xl/worksheets/sheet2.xml": strToU8(sheet2) } : {}),
    ...Object.fromEntries(more.map((x) => [`xl/worksheets/sheet${x.n}.xml`, strToU8(x.xml)])),
    ...options.extra,
  };
  files["xl/sharedStrings.xml"] = strToU8(
    `<?xml version="1.0" encoding="UTF-8"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${shared.length}" uniqueCount="${shared.length}">${shared.map((s) => `<si><t xml:space="preserve">${escapeXml(s)}</t></si>`).join("")}</sst>`,
  );
  return zipSync(files);
}
