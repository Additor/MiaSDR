import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { callRoute, createWorld, type World } from "@/test-support/route-client";
import { describeDb, dropOrgs, TEST_DATABASE_URL, useTestEnv } from "@/test-support/db";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", async () => (await import("@/test-support/route-client")).nextHeadersStandIn());
vi.mock("next/server", async (original) => (await import("@/test-support/route-client")).nextServerStandIn(await original()));

/**
 * The Contacts CSV and "Select all matching" routes ("Contacts and Companies CRUD" in docs/decisions.md): the file headers, the
 * columns (the decoded text drops the BOM, which crm-read's test pins), the filter and the ticked ids, dates in the organization's time zone, 422 for a bad filter as JSON, and 413
 * above 5,000 ids. crm-read's own test covers the row values in depth. Needs TEST_DATABASE_URL pointing at a migrated Postgres.
 */
describeDb("contacts export routes", () => {
  useTestEnv();
  let world: World;
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    world = await createWorld(TEST_DATABASE_URL ?? "");
    const org = world.orgA.id;
    // 23:30 UTC on 2026-10-18 is already 2026-10-19 in Tokyo.
    await world.sql`update organizations set timezone = 'Asia/Tokyo' where id = ${org}`;
    const [company] = await world.sql`insert into companies (organization_id, domain, name) values (${org}, 'export-acme.test', 'Acme') returning id`;
    const contact = async (name: string, email: string) =>
      (await world.sql`
        insert into people (organization_id, full_name, email, title, company_id, lifecycle, converted_at)
        values (${org}, ${name}, ${email}, 'Buyer', ${company.id}, 'contact', '2026-10-18T23:30:00Z') returning id`)[0].id as string;
    ids.ada = await contact("Ada Export", "ada@export.test");
    ids.bob = await contact("Bob Export", "bob@export.test");
    ids.lead = (await world.sql`insert into people (organization_id, full_name, email) values (${org}, 'Lena Lead', 'lena@export.test') returning id`)[0].id as string;
    ids.foreign = (await world.sql`
      insert into people (organization_id, full_name, email, lifecycle, converted_at) values (${world.orgB.id}, 'Olga Other', 'olga@export.test', 'contact', now()) returning id`)[0].id as string;
  }, 120_000);

  afterAll(async () => {
    if (!world) return;
    // Throws on a failed delete; world.close() then finds nothing left of the two organizations.
    await dropOrgs(world.sql, [{ organizationId: world.orgA.id }, { organizationId: world.orgB.id }]);
    await world.close();
  });

  const lines = (text: string) => text.replace(/^\uFEFF/, "").trim().split("\r\n");

  it("GET streams the filtered contacts as CSV with the header and ISO dates in the organization's zone", async () => {
    const result = await callRoute("contacts/export/route.ts", "GET", { query: { q: "export" }, as: world.member });
    expect(result.status).toBe(200);
    expect(result.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(result.headers.get("content-disposition")).toMatch(/^attachment; filename="contacts-\d{4}-\d{2}-\d{2}\.csv"$/);
    expect(result.headers.get("cache-control")).toBe("no-store");
    const [header, ...rows] = lines(result.text);
    expect(header.startsWith("Name,Email,Phone,LinkedIn,Job title,Company,Company domain,Deal owner,Latest deal,Stage,Open deals,Contact since,Last activity")).toBe(true);
    expect(rows).toHaveLength(2);
    expect(rows.join("\n")).toContain("Ada Export,ada@export.test,,,Buyer,Acme,export-acme.test,,,,0,2026-10-19");
    expect(result.text).not.toContain("Lena Lead");
    expect(result.text).not.toContain("Olga Other");
  });

  it("GET answers 422 as JSON for a bad filter, before any file starts", async () => {
    const result = await callRoute("contacts/export/route.ts", "GET", { query: { owner: "someone" }, as: world.member });
    expect(result.status).toBe(422);
    expect(result.body).toEqual({ error: "Filter by a member, me or none.", issues: [] });
  });

  it("POST exports the ticked contacts only: leads and other organizations' ids export nothing", async () => {
    const result = await callRoute("contacts/export/route.ts", "POST", { json: { ids: [ids.bob, ids.lead, ids.foreign, "not-a-uuid"] }, as: world.member });
    expect(result.status).toBe(200);
    const [, ...rows] = lines(result.text);
    expect(rows).toHaveLength(1);
    expect(rows[0].startsWith("Bob Export,bob@export.test")).toBe(true);
  });

  it("POST answers 413 above 5,000 ids and 400 for an empty list", async () => {
    const many = Array.from({ length: 5001 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`);
    const tooMany = await callRoute("contacts/export/route.ts", "POST", { json: { ids: many }, as: world.member });
    expect(tooMany.status).toBe(413);
    expect(tooMany.body).toEqual({ error: "Export up to 5,000 contacts at a time." });
    expect((await callRoute("contacts/export/route.ts", "POST", { json: { ids: [] }, as: world.member })).status).toBe(400);
  });

  it("GET /api/contacts/ids answers the matching ids, the total and whether the cap cut them", async () => {
    const result = await callRoute("contacts/ids/route.ts", "GET", { query: { q: "export" }, as: world.member });
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ ids: expect.arrayContaining([ids.ada, ids.bob]), total: 2, capped: false });
    expect((await callRoute("contacts/ids/route.ts", "GET", { query: { stage: "nope" }, as: world.member })).status).toBe(422);
  });
});
