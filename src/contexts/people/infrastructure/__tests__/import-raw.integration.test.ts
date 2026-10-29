import { strToU8, zipSync } from "fflate";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { Actor } from "@/shared/errors";
import { ValidationError } from "@/shared/errors";
import { suggestMapping } from "../../domain/import-plan";
import { RAW_LIMITS } from "../../domain/raw";
import { parseCsv } from "@/platform/files/csv";
import { parseXlsx } from "@/platform/files/xlsx";
import { describeDb, dropOrgs, testSql, useTestEnv } from "@/test-support/db";

/** Needs TEST_DATABASE_URL pointing at a migrated Postgres. */
/** These tests cover the "Do not map" path: unrecognized columns are suggested as custom fields now, so set them back to source data. */
const keepAsSourceData = (headers: string[]) => Object.fromEntries(Object.entries(suggestMapping(headers)).map(([header, target]) => [header, target.startsWith("custom:") ? "skip" : target]));

const colName = (i: number) => String.fromCharCode(65 + i);
const escapeXml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Text-only workbook: enough to carry headers and string cells through the real parser. */
function textXlsx(rows: string[][]): Buffer {
  const shared: string[] = [];
  const sheet = `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows
    .map(
      (row, r) =>
        `<row r="${r + 1}">${row
          .map((cell, c) => {
            shared.push(cell);
            return `<c r="${colName(c)}${r + 1}" t="s"><v>${shared.length - 1}</v></c>`;
          })
          .join("")}</row>`,
    )
    .join("")}</sheetData></worksheet>`;
  const files: Record<string, Uint8Array> = {
    "[Content_Types].xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>`,
    ),
    "_rels/.rels": strToU8(
      `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    ),
    "xl/workbook.xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Leads" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    ),
    "xl/_rels/workbook.xml.rels": strToU8(
      `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>`,
    ),
    "xl/worksheets/sheet1.xml": strToU8(sheet),
    "xl/sharedStrings.xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${shared.length}" uniqueCount="${shared.length}">${shared.map((s) => `<si><t xml:space="preserve">${escapeXml(s)}</t></si>`).join("")}</sst>`,
    ),
  };
  return Buffer.from(zipSync(files));
}

describeDb("import raw preservation", () => {
  useTestEnv();
  const sql = testSql({ max: 3 });
  let importLeads: typeof import("../../application/import-leads").importLeads;
  let previewImport: typeof import("../../application/import-leads").previewImport;
  let store: typeof import("../drizzle-lead-store").drizzleLeadStore;
  let uc: typeof import("../../application/lead-management");
  let deps: import("../../application/lead-ports").LeadDeps;
  let backfill: typeof import("../backfill-linkedin-urls").backfillLinkedinUrls;
  let orgA = "";
  let orgB = "";
  let user = "";
  let actorA: Actor;
  let actorB: Actor;

  beforeAll(async () => {
    ({ importLeads, previewImport } = await import("../../application/import-leads"));
    ({ drizzleLeadStore: store } = await import("../drizzle-lead-store"));
    ({ backfillLinkedinUrls: backfill } = await import("../backfill-linkedin-urls"));
    uc = await import("../../application/lead-management");
    deps = (await import("@/composition/leads")).leadDeps();

    const s = Math.random().toString(36).slice(2, 8);
    [{ id: orgA }] = await sql`insert into organizations (name, slug) values ('A', ${"ra-" + s}) returning id`;
    [{ id: orgB }] = await sql`insert into organizations (name, slug) values ('B', ${"rb-" + s}) returning id`;
    [{ id: user }] = await sql`insert into users (name, email) values ('U', ${s + "@raw.test"}) returning id`;
    actorA = { userId: user, organizationId: orgA, role: "member" };
    actorB = { userId: user, organizationId: orgB, role: "member" };
  });

  afterAll(async () => {
    await dropOrgs(sql, [{ organizationId: orgA }, { organizationId: orgB }], [user]);
    await sql.end();
  });

  const importFile = (organizationId: string, parsed: { headers: string[]; rows: Array<Record<string, string>> }) =>
    importLeads(
      { store },
      { organizationId, userId: user, filename: "f", headers: parsed.headers, rows: parsed.rows, mapping: keepAsSourceData(parsed.headers) },
    );

  const csv = [
    "Email,Name,LinkedIn,Website,Region,Company Size,Notes",
    'ann@raw.test,Ann,https://www.linkedin.com/in/Ann-Raw/,raw-co.test,EMEA,50,"=HYPERLINK(""http://evil"")"',
    "bob@raw.test,Bob,https://www.linkedin.com/company/bobco/,raw-co.test,APAC,,",
    "carl@raw.test,Carl,,,,,",
  ].join("\n");

  it("CSV: keeps unmapped columns, company columns and the LinkedIn URL", async () => {
    const report = await importFile(orgA, parseCsv(Buffer.from(csv)));
    expect(report.stats).toMatchObject({ created: 3, invalid: 0 });
    const rows = await sql`select email, linkedin_slug, linkedin_url, raw from people where organization_id = ${orgA} order by email`;
    expect(rows[0]).toMatchObject({
      linkedin_slug: "ann-raw",
      linkedin_url: "https://www.linkedin.com/in/ann-raw/",
      raw: { Region: "EMEA", Notes: '=HYPERLINK("http://evil")' },
    });
    expect(rows[1]).toMatchObject({ linkedin_slug: null, linkedin_url: "https://www.linkedin.com/company/bobco/", raw: { Region: "APAC" } });
    expect(rows[2].raw).toBeNull();
    const [company] = await sql`select raw from companies where organization_id = ${orgA} and domain = 'raw-co.test'`;
    expect(company.raw).toEqual({ "Company Size": "50" });
  });

  it("XLSX: gives the same stored result as CSV", async () => {
    const grid = csv.split("\n").map((line) => line.split(",").slice(0, 6));
    const parsed = await parseXlsx(textXlsx([grid[0], ["dee@raw.test", "Dee", "linkedin.com/in/dee", "raw-co.test", "LATAM", "70"]]));
    await importFile(orgA, parsed);
    const [dee] = await sql`select linkedin_url, raw from people where organization_id = ${orgA} and email = 'dee@raw.test'`;
    expect(dee).toMatchObject({ linkedin_url: "https://www.linkedin.com/in/dee/", raw: { Region: "LATAM" } });
    const [company] = await sql`select raw from companies where organization_id = ${orgA} and domain = 'raw-co.test'`;
    expect(company.raw).toEqual({ "Company Size": "70" });
  });

  it("re-importing merges raw by key and leaves other keys", async () => {
    const parsed = parseCsv(Buffer.from("Email,Tier\nann@raw.test,gold\n"));
    const report = await importFile(orgA, parsed);
    expect(report.stats.updated).toBe(1);
    const [ann] = await sql`select raw from people where organization_id = ${orgA} and email = 'ann@raw.test'`;
    expect(ann.raw).toEqual({ Region: "EMEA", Notes: '=HYPERLINK("http://evil")', Tier: "gold" });
    const again = await importFile(orgA, parsed);
    expect(again.stats).toMatchObject({ updated: 0, unchanged: 1 });
  });

  it("caps oversized cells and many columns, and reports the rows", async () => {
    const wide = Array.from({ length: RAW_LIMITS.maxKeys + 20 }, (_, i) => `Extra ${i}`);
    const header = ["Email", "Huge", ...wide].join(",");
    const row = ["cap@raw.test", "x".repeat(RAW_LIMITS.maxValueChars + 500), ...wide.map(() => "v")].join(",");
    const report = await importFile(orgA, parseCsv(Buffer.from(`${header}\n${row}\n`)));
    expect(report.stats.rawTruncatedRows).toBe(1);
    const [cap] = await sql`select raw, octet_length(raw::text) as bytes from people where organization_id = ${orgA} and email = 'cap@raw.test'`;
    expect(Object.keys(cap.raw).length).toBeLessThanOrEqual(RAW_LIMITS.maxKeys);
    expect(cap.raw.Huge).toHaveLength(RAW_LIMITS.maxValueChars);
    expect(cap.bytes).toBeLessThan(262144);
  });

  it("export keeps raw as one JSON cell and formula-looking cells inert", async () => {
    await sql`update people set first_name = '=cmd|calc', linkedin_url = '+https://x' where organization_id = ${orgA} and email = 'carl@raw.test'`;
    let text = "";
    for await (const chunk of uc.exportLeadsCsv(deps, actorA, {})) text += chunk;
    const lines = text.split("\r\n");
    expect(lines[0]).toContain("Source data");
    expect(text).toContain("'=cmd|calc");
    expect(text).toContain("'+https://x");
    const ann = lines.find((l) => l.includes("ann@raw.test")) ?? "";
    expect(ann).toContain("https://www.linkedin.com/in/ann-raw/");
    expect(ann).toContain('""Region"":""EMEA""');
    expect(ann.split(",").some((cell) => /^[=+@-]/.test(cell))).toBe(false);
  });

  it("backfill fills the URL from the slug once and is idempotent", async () => {
    await sql`insert into people (organization_id, email, linkedin_slug) values (${orgA}, 'old@raw.test', 'old-lead'), (${orgA}, 'jorg@raw.test', ${"jörg-m"})`;
    const first = await backfill(orgA);
    expect(first).toBe(2);
    expect(await backfill(orgA)).toBe(0);
    const rows = await sql`select email, linkedin_url from people where organization_id = ${orgA} and email in ('old@raw.test', 'jorg@raw.test') order by email`;
    expect(rows.map((r) => r.linkedin_url)).toEqual(["https://www.linkedin.com/in/j%C3%B6rg-m/", "https://www.linkedin.com/in/old-lead/"]);
    const [other] = await sql`select count(*)::int as n from people where organization_id = ${orgB}`;
    expect(other.n).toBe(0);
  });

  it("Map this field creates the column, backfills custom from raw, keeps raw, and is idempotent", async () => {
    await sql`update people set custom = custom || '{}'::jsonb where organization_id = ${orgA}`;
    const first = await uc.mapRawField(deps, actorA, { rawKey: "Region", name: "Region" });
    expect(first.key).toBe("x_region");
    expect(first.updated).toBe(3); // ann, bob, dee
    const rows = await sql`select email, custom, raw from people where organization_id = ${orgA} and raw ? 'Region' order by email`;
    expect(rows.map((r) => r.custom.x_region)).toEqual(["EMEA", "APAC", "LATAM"]);
    expect(rows.every((r) => r.raw.Region)).toBe(true);
    const [column] = await sql`select name from entity_columns where organization_id = ${orgA} and key = 'x_region'`;
    expect(column.name).toBe("Region");

    expect((await uc.mapRawField(deps, actorA, { rawKey: "Region", name: "Region" })).updated).toBe(0);

    await sql`update people set custom = jsonb_set(custom, '{x_region}', '"Manual"') where organization_id = ${orgA} and email = 'ann@raw.test'`;
    expect((await uc.mapRawField(deps, actorA, { rawKey: "Region", name: "Region" })).updated).toBe(0);
    const [ann] = await sql`select custom from people where organization_id = ${orgA} and email = 'ann@raw.test'`;
    expect(ann.custom.x_region).toBe("Manual");
    expect((await uc.mapRawField(deps, actorA, { rawKey: "Region", name: "Region", overwrite: true })).updated).toBe(1);
  });

  it("Map this field never touches another organization", async () => {
    await sql`insert into people (organization_id, email, raw) values (${orgB}, 'b@raw.test', '{"Region":"B-ONLY"}')`;
    await uc.mapRawField(deps, actorA, { rawKey: "Region", name: "Region", overwrite: true });
    const [b] = await sql`select custom from people where organization_id = ${orgB}`;
    expect(b.custom).toEqual({});
    await uc.mapRawField(deps, actorB, { rawKey: "Region", name: "Region" });
    const [b2] = await sql`select custom from people where organization_id = ${orgB}`;
    expect(b2.custom).toEqual({ x_region: "B-ONLY" });
  });

  it("rejects empty or oversized names", async () => {
    await expect(uc.mapRawField(deps, actorA, { rawKey: "Region", name: "  " })).rejects.toBeInstanceOf(ValidationError);
    await expect(uc.mapRawField(deps, actorA, { rawKey: "k".repeat(101), name: "x" })).rejects.toBeInstanceOf(ValidationError);
  });

  it("lead detail returns the raw data and company raw", async () => {
    const [{ id }] = await sql`select id from people where organization_id = ${orgA} and email = 'dee@raw.test'`;
    const lead = await uc.getLead(deps, actorA, id);
    expect(lead.person.raw).toMatchObject({ Region: "LATAM" });
    expect(lead.person.companyRaw).toMatchObject({ "Company Size": expect.any(String) });
    expect(lead.person.linkedinUrl).toBe("https://www.linkedin.com/in/dee/");
  });

  it("lands rows with another domain of a company on that company, in the preview and the import alike", async () => {
    const [{ id: org }] = await sql`insert into organizations (name, slug) values ('C', ${"rc-" + user.slice(0, 8)}) returning id`;
    try {
      const [{ id: acme }] = await sql`insert into companies (organization_id, domain, name, raw) values (${org}, 'acme-alias.test', 'Acme', '{"Company Region":"EU"}') returning id`;
      await sql`insert into company_domain_aliases (organization_id, company_id, domain) values (${org}, ${acme}, 'globex-alias.test')`;
      await sql`insert into people (organization_id, email, company_id) values (${org}, 'jane@alias.test', ${acme})`;
      // Jane sits at Acme already, so the alias moves her nowhere; without the alias map her row would read as an update.
      const parsed = parseCsv(Buffer.from("Email,Website,Company Size\njane@alias.test,globex-alias.test,\nnew@alias.test,https://www.globex-alias.test/,50\n"));
      const command = { organizationId: org, headers: parsed.headers, rows: parsed.rows, mapping: keepAsSourceData(parsed.headers) };

      const preview = await previewImport({ store }, command);
      const report = await importLeads({ store }, { ...command, userId: user, filename: "alias.csv" });
      expect({ created: preview.created, updated: preview.updated, unchanged: preview.unchanged }).toEqual({ created: 1, updated: 0, unchanged: 1 });
      expect(report.stats).toMatchObject({ created: 1, updated: 0, unchanged: 1, companiesCreated: 0 });

      const companies = await sql`select id, domain, raw, version from companies where organization_id = ${org}`;
      expect(companies).toEqual([{ id: acme, domain: "acme-alias.test", raw: { "Company Region": "EU", "Company Size": "50" }, version: 1 }]);
      const people = await sql`select email, company_id from people where organization_id = ${org} order by email`;
      expect(people.map((p) => p.company_id)).toEqual([acme, acme]);
    } finally {
      await sql`delete from people where organization_id = ${org}`;
      await sql`delete from companies where organization_id = ${org}`;
      await sql`delete from import_runs where organization_id = ${org}`;
      await sql`delete from organizations where id = ${org}`;
    }
  });

  it("keeps a company listed when an import moves its last contact away", async () => {
    const [{ id: org }] = await sql`insert into organizations (name, slug) values ('D', ${"rd-" + user.slice(0, 8)}) returning id`;
    try {
      const [{ id: initech }] = await sql`insert into companies (organization_id, domain, name) values (${org}, 'initech-move.test', 'Initech') returning id`;
      const [{ id: hooli }] = await sql`insert into companies (organization_id, domain, name) values (${org}, 'hooli-move.test', 'Hooli') returning id`;
      await sql`insert into people (organization_id, email, company_id, lifecycle, converted_at) values (${org}, 'cora@move.test', ${initech}, 'contact', now())`;
      await sql`insert into people (organization_id, email, company_id) values (${org}, 'lena@move.test', ${hooli})`;
      const parsed = parseCsv(Buffer.from("Email,Website\ncora@move.test,acme-move.test\nlena@move.test,acme-move.test\n"));
      await importLeads({ store }, { organizationId: org, userId: user, filename: "move.csv", headers: parsed.headers, rows: parsed.rows, mapping: keepAsSourceData(parsed.headers) });
      const [left] = await sql`select crm_listed_at, version from companies where id = ${initech}`;
      expect(left.crm_listed_at).not.toBeNull();
      expect(left.version).toBe(1);
      // A company that only lost a lead stays off the list.
      const [leadsOnly] = await sql`select crm_listed_at from companies where id = ${hooli}`;
      expect(leadsOnly.crm_listed_at).toBeNull();
    } finally {
      await sql`delete from people where organization_id = ${org}`;
      await sql`delete from companies where organization_id = ${org}`;
      await sql`delete from import_runs where organization_id = ${org}`;
      await sql`delete from organizations where id = ${org}`;
    }
  });

  it("measures alias resolution on a 10,000-row file and lands every alias row on its company (risk 6)", async () => {
    const [{ id: org }] = await sql`insert into organizations (name, slug) values ('E', ${"re-" + user.slice(0, 8)}) returning id`;
    try {
      const kept = await sql`insert into companies (organization_id, domain, name) select ${org}, 'kept' || g || '.test', 'Kept ' || g from generate_series(1, 250) g returning id, domain`;
      await sql`insert into company_domain_aliases (organization_id, company_id, domain) select ${org}, c.id, replace(c.domain, 'kept', 'alias') from companies c where c.organization_id = ${org}`;
      const lines = ["Email,Website"];
      for (let i = 0; i < 10_000; i += 1) lines.push(`p${i}@size.test,${i % 2 === 0 ? "alias" : "other"}${(Math.floor(i / 2) % 250) + 1}.test`);
      const parsed = parseCsv(Buffer.from(lines.join("\n")));
      const command = { organizationId: org, headers: parsed.headers, rows: parsed.rows, mapping: keepAsSourceData(parsed.headers) };
      const started = performance.now();
      const preview = await previewImport({ store }, command);
      const previewMs = performance.now() - started;
      const report = await importLeads({ store }, { ...command, userId: user, filename: "size.csv" });
      const totalMs = performance.now() - started;
      console.info(`10,000-row import with 250 other domains: preview ${Math.round(previewMs)} ms, preview and import ${Math.round(totalMs)} ms`);
      expect(preview.created).toBe(10_000);
      // 250 "other" domains are new; the 250 alias domains land on the kept companies.
      expect(report.stats).toMatchObject({ created: 10_000, companiesCreated: 250 });
      expect(await sql`select count(*)::int as n from companies where organization_id = ${org}`).toEqual([{ n: kept.length + 250 }]);
    } finally {
      await sql`delete from people where organization_id = ${org}`;
      await sql`delete from companies where organization_id = ${org}`;
      await sql`delete from import_runs where organization_id = ${org}`;
      await sql`delete from organizations where id = ${org}`;
    }
  }, 120_000);
});
