import { afterAll, expect, it } from "vitest";
import { describeDb, dropOrgs, testSql } from "../../../test-support/db";
import { seedWorld, type World } from "../../../test-support/full-world";

/**
 * Migration 0017: knowledge_documents.latest_version must point at a row of knowledge_document_versions.
 * The key is DEFERRABLE INITIALLY DEFERRED, so a document and its first version can go in one transaction. Needs TEST_DATABASE_URL.
 */
const FK = /knowledge_documents_latest_version_fk/;

describeDb("knowledge_documents_latest_version_fk (0017)", () => {
  const sql = testSql();
  const worlds: World[] = [];
  const world = async () => {
    const w = await seedWorld(sql);
    worlds.push(w);
    return w;
  };
  afterAll(async () => {
    await dropOrgs(sql, worlds.map((w) => ({ organizationId: w.org, userId: w.user })));
    await sql.end();
  });

  it("is deferrable, initially deferred and validated", async () => {
    const [row] = await sql`
      select condeferrable, condeferred, convalidated, pg_get_constraintdef(oid) as def
      from pg_constraint where conname = 'knowledge_documents_latest_version_fk'`;
    expect(row).toMatchObject({ condeferrable: true, condeferred: true, convalidated: true });
    expect(row.def).toContain("FOREIGN KEY (id, latest_version) REFERENCES knowledge_document_versions(document_id, version)");
  });

  it("refuses a document that commits without its version row", async () => {
    const w = await world();
    await expect(sql`insert into knowledge_documents (organization_id, title, kind) values (${w.org}, 'alone', 'faq')`).rejects.toThrow(FK);
    expect((await sql`select 1 from knowledge_documents where organization_id = ${w.org} and title = 'alone'`).length).toBe(0);
  });

  it("accepts the document and its first version in one transaction, in either order", async () => {
    const w = await world();
    await sql.begin(async (tx) => {
      const [doc] = await tx`insert into knowledge_documents (organization_id, title, kind) values (${w.org}, 'doc first', 'faq') returning id`;
      await tx`insert into knowledge_document_versions (organization_id, document_id, version, content) values (${w.org}, ${doc.id}, 1, 'c')`;
    });
    await sql.begin(async (tx) => {
      const [doc] = await tx`insert into knowledge_documents (organization_id, title, kind, latest_version) values (${w.org}, 'late version', 'faq', 3) returning id`;
      await tx`insert into knowledge_document_versions (organization_id, document_id, version, content) values (${w.org}, ${doc.id}, 3, 'c')`;
    });
  });

  it("accepts latest_version raised before its row exists when the row follows in the same transaction", async () => {
    const w = await world();
    await sql.begin(async (tx) => {
      await tx`update knowledge_documents set latest_version = 2 where id = ${w.knowledgeDoc}`;
      await tx`insert into knowledge_document_versions (organization_id, document_id, version, content) values (${w.org}, ${w.knowledgeDoc}, 2, 'next')`;
    });
    const [row] = await sql`select latest_version from knowledge_documents where id = ${w.knowledgeDoc}`;
    expect(row.latest_version).toBe(2);
  });

  it("refuses latest_version that points at a version which does not exist", async () => {
    const w = await world();
    await expect(sql`update knowledge_documents set latest_version = 7 where id = ${w.knowledgeDoc}`).rejects.toThrow(FK);
    const [row] = await sql`select latest_version from knowledge_documents where id = ${w.knowledgeDoc}`;
    expect(row.latest_version).toBe(1);
  });

  it("lets a document delete cascade to its versions", async () => {
    const w = await world();
    await sql`delete from knowledge_documents where id = ${w.knowledgeDoc}`;
    expect((await sql`select 1 from knowledge_document_versions where document_id = ${w.knowledgeDoc}`).length).toBe(0);
  });

  it("lets an organization delete cascade through documents and versions", async () => {
    const w = await world();
    await sql`delete from organizations where id = ${w.org}`;
    expect((await sql`select 1 from knowledge_documents where organization_id = ${w.org}`).length).toBe(0);
  });
});
