import { afterAll, expect, it } from "vitest";
import { ConflictError, NotFoundError, ValidationError, type Actor } from "@/shared/errors";
import { createTestOrg, describeDb, dropOrgs, testSql, useTestEnv, type TestOrg } from "@/test-support/db";
import { addBrainItem, changeBrainItem, getBrainItem, listBrainItems } from "../../application/brain-items";
import { drizzleBrainStore as store } from "../drizzle-brain-store";

describeDb("Brain items", () => {
  useTestEnv();
  const sql = testSql({ max: 2 });
  const orgs: TestOrg[] = [];

  async function fixture(role = "member"): Promise<Actor> {
    const org = await createTestOrg(sql, "Brain", role);
    orgs.push(org);
    return { userId: org.userId, organizationId: org.organizationId, role };
  }

  async function legacy(org: string, title: string, kind = "unsorted", alwaysInclude = false) {
    return sql.begin(async (tx) => {
      const [doc] = await tx`insert into knowledge_documents (organization_id, title, kind, always_include) values (${org}, ${title}, ${kind}, ${alwaysInclude}) returning id`;
      await tx`insert into knowledge_document_versions (organization_id, document_id, version, content) values (${org}, ${doc.id}, 1, 'Pasted text')`;
      return doc.id as string;
    });
  }

  const audits = (org: string) => sql`select action, entity_id, actor_user_id, meta from audit_log where organization_id = ${org} and action like 'brain.%' order by created_at, id`;

  afterAll(async () => {
    await dropOrgs(sql, orgs);
    await sql.end();
  });

  it("lets a member create, read and change an item, and records who did", async () => {
    const actor = await fixture("member");
    const { id } = await addBrainItem(store, actor, { kind: "product", fields: { productName: "Mia", overview: "An AI SDR" }, tags: [" Sales "], description: " For teams " });
    expect(await getBrainItem(store, actor, id)).toMatchObject({
      title: "Mia",
      kind: "product",
      description: "For teams",
      tags: ["sales"],
      version: 1,
      legacy: false,
      content: "Product name: Mia\nOverview: An AI SDR",
      structuredData: { productName: "Mia", overview: "An AI SDR" },
    });
    const [row] = await sql`select created_by from knowledge_documents where id = ${id}`;
    expect(row.created_by).toBe(actor.userId);

    await changeBrainItem(store, actor, id, { fields: { productName: "Mia 2" } });
    expect(await getBrainItem(store, actor, id)).toMatchObject({ title: "Mia 2", version: 2, content: "Product name: Mia 2", tags: ["sales"] });
    const old = await sql`select content, structured_data from knowledge_document_versions where document_id = ${id} and version = 1`;
    expect(old[0]).toMatchObject({ content: "Product name: Mia\nOverview: An AI SDR", structured_data: { productName: "Mia", overview: "An AI SDR" } });

    expect((await audits(actor.organizationId)).map((a) => [a.action, a.actor_user_id])).toEqual([
      ["brain.item_created", actor.userId],
      ["brain.item_updated", actor.userId],
    ]);
  });

  it("adds no version when the stored fields come back unchanged, whatever order jsonb keeps them in", async () => {
    const actor = await fixture();
    const fields = { entryName: "Pro", pricing: { currency: "USD" }, monthlyPrice: 99, annualPrice: 990, features: ["SSO"], notes: "n" };
    const { id } = await addBrainItem(store, actor, { kind: "price_book", fields });
    const stored = (await getBrainItem(store, actor, id)).structuredData!;
    await changeBrainItem(store, actor, id, { fields: stored });
    expect((await getBrainItem(store, actor, id)).version).toBe(1);
  });

  it("keeps one active company profile: a second one, or a restore beside one, is a conflict", async () => {
    const actor = await fixture();
    const fields = { companyName: "Acme" };
    const first = await addBrainItem(store, actor, { kind: "company_profile", fields });
    await expect(addBrainItem(store, actor, { kind: "company_profile", fields })).rejects.toBeInstanceOf(ConflictError);
    expect((await listBrainItems(store, actor, { view: "all" })).hasCompanyProfile).toBe(true);

    await changeBrainItem(store, actor, first.id, { active: false });
    expect((await listBrainItems(store, actor, { view: "all" })).hasCompanyProfile).toBe(false);
    await addBrainItem(store, actor, { kind: "company_profile", fields: { companyName: "Acme 2" } });
    await expect(changeBrainItem(store, actor, first.id, { active: true })).rejects.toBeInstanceOf(ConflictError);
    expect((await audits(actor.organizationId)).map((a) => a.action)).toEqual(["brain.item_created", "brain.item_archived", "brain.item_created"]);
  });

  it("rolls the whole change back when the fields are refused", async () => {
    const actor = await fixture();
    const { id } = await addBrainItem(store, actor, { kind: "product", fields: { productName: "Mia" } });
    await expect(changeBrainItem(store, actor, id, { tags: ["x"], fields: {} })).rejects.toBeInstanceOf(ValidationError);
    expect((await getBrainItem(store, actor, id)).tags).toEqual([]);
    expect(await audits(actor.organizationId)).toHaveLength(1);
  });

  it("sorts a pasted document into a kind, which starts its fields, and keeps the old text as a version", async () => {
    const actor = await fixture();
    const id = await legacy(actor.organizationId, "Old FAQ", "unsorted", true);
    expect(await getBrainItem(store, actor, id)).toMatchObject({ legacy: true, structuredData: null, content: "Pasted text" });
    await expect(changeBrainItem(store, actor, id, { kind: "unsorted", fields: {} })).rejects.toBeInstanceOf(ValidationError);
    await changeBrainItem(store, actor, id, { kind: "product", fields: { productName: "Mia" } });
    expect(await getBrainItem(store, actor, id)).toMatchObject({ kind: "product", title: "Mia", legacy: false, version: 2, alwaysInclude: true });
    expect((await sql`select content from knowledge_document_versions where document_id = ${id} and version = 1`)[0].content).toBe("Pasted text");
    await expect(changeBrainItem(store, actor, id, { kind: "icp", fields: { icpName: "x" } })).rejects.toBeInstanceOf(ValidationError);
  });

  it("lists by view, title search and archived state, without the text, and counts what needs sorting", async () => {
    const actor = await fixture();
    const org = actor.organizationId;
    await addBrainItem(store, actor, { kind: "product", fields: { productName: "Mia 100%" } });
    await addBrainItem(store, actor, { kind: "icp", fields: { icpName: "SaaS" } });
    const off = await addBrainItem(store, actor, { kind: "competitor", fields: { competitorName: "Rival" } });
    await changeBrainItem(store, actor, off.id, { active: false });
    await legacy(org, "Pasted");
    await legacy(org, "Old price sheet", "price_book");

    const titles = async (query: Parameters<typeof listBrainItems>[2]) => (await listBrainItems(store, actor, query)).rows.map((r) => r.title);
    expect(await titles({ view: "all" })).toEqual(["Mia 100%", "Old price sheet", "Pasted", "SaaS"]);
    expect(await titles({ view: "company" })).toEqual(["Mia 100%", "Old price sheet"]);
    expect(await titles({ view: "market" })).toEqual(["SaaS"]);
    expect(await titles({ view: "skills" })).toEqual([]);
    expect(await titles({ view: "needs_sorting" })).toEqual(["Old price sheet", "Pasted"]);
    expect(await titles({ view: "all", archived: true })).toEqual(["Rival"]);
    expect(await titles({ view: "all", q: "100%" })).toEqual(["Mia 100%"]);
    expect(await titles({ view: "all", q: "%" })).toEqual(["Mia 100%"]);
    const listed = await listBrainItems(store, actor, { view: "all" });
    expect(listed).toMatchObject({ total: 4, needsSorting: 2, page: 1 });
    expect(listed.rows[0]).not.toHaveProperty("content");
  });

  it("answers not found for another organization's item and a malformed id", async () => {
    const actor = await fixture();
    const other = await fixture();
    const { id } = await addBrainItem(store, actor, { kind: "product", fields: { productName: "Mia" } });
    await expect(getBrainItem(store, other, id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(changeBrainItem(store, other, id, { tags: [] })).rejects.toBeInstanceOf(NotFoundError);
    await expect(getBrainItem(store, actor, "nope")).rejects.toBeInstanceOf(NotFoundError);
    expect((await getBrainItem(store, actor, id)).tags).toEqual([]);
  });

  it("keeps an item when its creator is deleted", async () => {
    const actor = await fixture();
    const { id } = await addBrainItem(store, actor, { kind: "product", fields: { productName: "Mia" } });
    const [{ fk }] = await sql`select confdeltype as fk from pg_constraint where conname = 'knowledge_documents_created_by_users_id_fk'`;
    expect(fk).toBe("n");
    expect((await getBrainItem(store, actor, id)).title).toBe("Mia");
  });
});
