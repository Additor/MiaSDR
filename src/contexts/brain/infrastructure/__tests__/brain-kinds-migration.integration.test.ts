import { mkdtempSync, readFileSync, rmSync, writeFileSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, expect, it } from "vitest";
import { describeDb, TEST_DATABASE_URL } from "@/test-support/db";
import { adminAndScratchUrls, readJournal } from "@/test-support/migration-test-kit";

const MIGRATION = "0005_knowledge_structured_items";

/** Builds a scratch database at the migration before this one, fills it, applies this one and checks what it did to the rows. */
describeDb("the migration to Brain kinds", () => {
  const name = `miasdr_brain_kinds_${Math.random().toString(36).slice(2, 8)}`;
  const { admin, scratch } = adminAndScratchUrls(TEST_DATABASE_URL ?? "postgres://x@localhost/x", name);
  const adminSql = postgres(admin, { max: 1, onnotice: () => undefined });
  const sql = postgres(scratch, { max: 1, onnotice: () => undefined });
  const dir = mkdtempSync(path.join(tmpdir(), "brain-kinds-"));

  /** The migrations up to, and without, this one. */
  function folderBefore(): string {
    const before = path.join(dir, "before");
    cpSync(path.join(process.cwd(), "drizzle"), before, { recursive: true });
    const journal = readJournal();
    writeFileSync(path.join(before, "meta/_journal.json"), JSON.stringify({ ...journal, entries: journal.entries.filter((e) => e.tag !== MIGRATION) }));
    return before;
  }

  async function doc(org: string, title: string, kind: string, active: boolean, updatedAt: string) {
    await sql.begin(async (tx) => {
      const [row] = await tx`insert into knowledge_documents (organization_id, title, kind, active, always_include, updated_at) values (${org}, ${title}, ${kind}, ${active}, true, ${updatedAt}) returning id`;
      await tx`insert into knowledge_document_versions (organization_id, document_id, version, content) values (${org}, ${row.id}, 1, ${`${title} text`})`;
    });
  }

  const kindOf = async (org: string, title: string) => (await sql`select kind from knowledge_documents where organization_id = ${org} and title = ${title}`)[0].kind as string;

  let a: string;
  let b: string;

  beforeAll(async () => {
    await adminSql.unsafe(`create database ${name}`);
    const db = drizzle(sql);
    await migrate(db, { migrationsFolder: folderBefore() });
    a = (await sql`insert into organizations (name, slug) values ('A', ${`${name}-a`}) returning id`)[0].id;
    b = (await sql`insert into organizations (name, slug) values ('B', ${`${name}-b`}) returning id`)[0].id;
    await doc(a, "Old company", "company", true, "2026-01-01");
    await doc(a, "New company", "company", true, "2026-02-01");
    await doc(a, "Tie one", "company", true, "2026-01-01");
    await doc(a, "Archived company", "company", false, "2026-03-01");
    await doc(a, "Prices", "pricing", true, "2026-01-01");
    await doc(a, "No", "objection", true, "2026-01-01");
    await doc(a, "Mia", "product", true, "2026-01-01");
    await doc(a, "Story", "case_study", false, "2026-01-01");
    await doc(a, "Questions", "faq", true, "2026-01-01");
    await doc(a, "Calendar", "scheduling", true, "2026-01-01");
    await doc(a, "Other", "custom", false, "2026-01-01");
    await doc(b, "Tie A", "company", true, "2026-01-01");
    await doc(b, "Tie B", "company", true, "2026-01-01");
    await migrate(db, { migrationsFolder: path.join(process.cwd(), "drizzle") });
  });

  afterAll(async () => {
    await sql.end();
    await adminSql.unsafe(`drop database if exists ${name} with (force)`);
    await adminSql.end();
    rmSync(dir, { recursive: true, force: true });
  });

  it("is the migration this test names", () => {
    expect(readFileSync(path.join(process.cwd(), "drizzle", `${MIGRATION}.sql`), "utf8")).toContain("knowledge_company_profile_uq");
  });

  it("keeps the newest active company as the profile and leaves the others to sort", async () => {
    expect(await kindOf(a, "New company")).toBe("company_profile");
    expect(await kindOf(a, "Old company")).toBe("unsorted");
    expect(await kindOf(a, "Tie one")).toBe("unsorted");
  });

  it("settles a tie on updated_at, so the unique index holds", async () => {
    const kinds = [await kindOf(b, "Tie A"), await kindOf(b, "Tie B")].sort();
    expect(kinds).toEqual(["company_profile", "unsorted"]);
  });

  it("moves an archived company to company_profile, which the index does not count", async () => {
    expect(await kindOf(a, "Archived company")).toBe("company_profile");
  });

  it("maps the other kinds", async () => {
    expect(await kindOf(a, "Prices")).toBe("price_book");
    expect(await kindOf(a, "No")).toBe("objection_handling");
    expect(await kindOf(a, "Mia")).toBe("product");
    expect(await kindOf(a, "Story")).toBe("case_study");
    for (const title of ["Questions", "Calendar", "Other"]) expect(await kindOf(a, title)).toBe("unsorted");
  });

  it("changes nothing else on a document, and leaves its versions without fields", async () => {
    const [row] = await sql`select active, always_include, latest_version, updated_at::date::text as day from knowledge_documents where title = 'Other'`;
    expect(row).toMatchObject({ active: false, always_include: true, latest_version: 1 });
    expect(row.day).toBe("2026-01-01");
    const versions = await sql`select content, structured_data from knowledge_document_versions where document_id in (select id from knowledge_documents where title = 'Other')`;
    expect(versions).toEqual([{ content: "Other text", structured_data: null }]);
  });

  it("refuses an old kind and a second active company profile afterwards", async () => {
    await expect(sql`update knowledge_documents set kind = 'faq' where title = 'Mia'`).rejects.toThrow(/knowledge_documents_kind_ck/);
    await expect(sql`update knowledge_documents set kind = 'company_profile' where title = 'Mia'`).rejects.toThrow(/knowledge_company_profile_uq/);
  });
});
