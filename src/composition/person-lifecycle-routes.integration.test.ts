import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { describeDb, dropOrgs, TEST_DATABASE_URL, uniqueKey } from "@/test-support/db";
import { callRoute, createWorld, type World } from "@/test-support/route-client";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", async () => (await import("@/test-support/route-client")).nextHeadersStandIn());
vi.mock("next/server", async (original) => (await import("@/test-support/route-client")).nextServerStandIn(await original()));

/**
 * The HTTP contract of the people and company routes of "Contacts and Companies CRUD" in docs/decisions.md, as the UI
 * calls them: status codes, error codes and body shapes over the composition root. The route matrix covers 401, 404 across
 * organizations and malformed bodies for every route; the use case tests cover the rules. Needs TEST_DATABASE_URL pointing at a
 * migrated Postgres.
 */
describeDb("person lifecycle routes", () => {
  let world: World;
  const tag = uniqueKey();

  beforeAll(async () => {
    world = await createWorld(TEST_DATABASE_URL ?? "");
  }, 120_000);

  afterAll(async () => {
    if (!world) return;
    // dropOrgs throws on a failed delete; close() then removes the users and ends the client.
    await dropOrgs(world.sql, [{ organizationId: world.orgA.id }, { organizationId: world.orgB.id }]);
    await world.close();
  });

  const lead = async (name: string, email: string) =>
    (await world.sql`insert into people (organization_id, full_name, email) values (${world.orgA.id}, ${name}, ${email}) returning id`)[0].id as string;

  it("POST /api/contacts answers 201, 200 on a replay, and 409 lead_exists for a lead's email", async () => {
    const body = { firstName: "Ada", lastName: "Add", email: `ada-${tag}@routes.test`, companyDomain: `ada-${tag}.test`, idempotencyKey: `add-${tag}-1` };
    const created = await callRoute("contacts/route.ts", "POST", { json: body, as: world.member });
    expect(created.status).toBe(201);
    expect(created.body).toEqual({ personId: expect.any(String) });
    const replay = await callRoute("contacts/route.ts", "POST", { json: body, as: world.member });
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual(created.body);

    const leadId = await lead("Lena Lead", `lena-${tag}@routes.test`);
    const taken = await callRoute("contacts/route.ts", "POST", { json: { email: `LENA-${tag}@routes.test`, idempotencyKey: `add-${tag}-2` }, as: world.member });
    expect(taken.status).toBe(409);
    expect(taken.body).toEqual({ error: `Lena Lead (lena-${tag}@routes.test) is already a lead.`, code: "lead_exists", personId: leadId, name: "Lena Lead", email: `lena-${tag}@routes.test`, others: [] });

    const short = await callRoute("contacts/route.ts", "POST", { json: { email: `short-${tag}@routes.test`, idempotencyKey: "short" }, as: world.member });
    expect(short.status).toBe(422);
    const noIdentity = await callRoute("contacts/route.ts", "POST", { json: { firstName: "Nobody", idempotencyKey: `add-${tag}-3` }, as: world.member });
    expect(noIdentity.status).toBe(422);
  });

  it("POST /api/contacts with a deal answers 201 with both ids and 200 on a replay", async () => {
    const body = { email: `deal-${tag}@routes.test`, firstName: "Dee", deal: { title: "First order" }, idempotencyKey: `deal-${tag}-1` };
    const created = await callRoute("contacts/route.ts", "POST", { json: body, as: world.member });
    expect(created.status).toBe(201);
    expect(created.body).toEqual({ personId: expect.any(String), dealId: expect.any(String) });
    const replay = await callRoute("contacts/route.ts", "POST", { json: body, as: world.member });
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual(created.body);
  });

  it("delete preview and DELETE /api/contacts/[id]: 422 for a missing count, 409 counts_changed, 200 with the counts, then 404", async () => {
    const created = await callRoute("contacts/route.ts", "POST", { json: { email: `gone-${tag}@routes.test`, firstName: "Gus", idempotencyKey: `gone-${tag}-1` }, as: world.member });
    const personId = (created.body as { personId: string }).personId;
    const preview = await callRoute("contacts/[id]/delete-preview/route.ts", "GET", { params: { id: personId }, as: world.member });
    expect(preview.status).toBe(200);
    expect(preview.body).toMatchObject({ person: { id: personId, fullName: "Gus", email: `gone-${tag}@routes.test`, doNotContact: false }, blockers: [], suppressionKept: false, hiddenExcluded: false });
    const counts = (preview.body as { counts: Record<string, number> & { deals: { won: number; lost: number } } }).counts;
    const query = { deals: "0", notes: String(counts.notes), tasks: String(counts.tasks), events: String(counts.events), conversations: "0", messages: "0", sends: "0" };

    const { sends: _dropped, ...missing } = query;
    void _dropped;
    const invalid = await callRoute("contacts/[id]/route.ts", "DELETE", { params: { id: personId }, query: missing, as: world.member });
    expect(invalid.status).toBe(422);
    expect(invalid.body).toEqual({ error: "Send the counts the delete dialog showed.", issues: [] });

    const stale = await callRoute("contacts/[id]/route.ts", "DELETE", { params: { id: personId }, query: { ...query, notes: "7" }, as: world.member });
    expect(stale.status).toBe(409);
    expect(stale.body).toEqual({ error: "Gus changed while this was open. Check the new counts and confirm again.", code: "counts_changed", counts });

    const deleted = await callRoute("contacts/[id]/route.ts", "DELETE", { params: { id: personId }, query, as: world.member });
    expect(deleted.status).toBe(200);
    expect(deleted.body).toEqual({ deleted: counts });
    const again = await callRoute("contacts/[id]/route.ts", "DELETE", { params: { id: personId }, query, as: world.member });
    expect(again.status).toBe(404);
    expect(again.body).toEqual({ error: "This contact no longer exists." });

    const leadId = await lead("Liam Lead", `liam-${tag}@routes.test`);
    const notContact = await callRoute("contacts/[id]/delete-preview/route.ts", "GET", { params: { id: leadId }, as: world.member });
    expect(notContact.status).toBe(409);
    expect(notContact.body).toEqual({ error: "Liam Lead is a lead. Delete leads from the lead page.", code: "not_a_contact" });
  });

  it("POST /api/leads/[id]/make-contact answers 200, then 409 already_converted", async () => {
    const leadId = await lead("Mia Make", `mia-${tag}@routes.test`);
    const made = await callRoute("leads/[id]/make-contact/route.ts", "POST", { params: { id: leadId }, json: {}, as: world.member });
    expect(made.status).toBe(200);
    expect(made.body).toEqual({ personId: leadId, stopped: { enrollments: 0, runs: 0, drafts: 0 } });
    const again = await callRoute("leads/[id]/make-contact/route.ts", "POST", { params: { id: leadId }, json: {}, as: world.member });
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({ code: "already_converted", personId: leadId });
  });

  it("POST /api/crm/people/dnc marks people, skips the marked and the missing, and answers 422 without a reason", async () => {
    const a = await lead("Dan One", `dnc1-${tag}@routes.test`);
    const missing = "00000000-0000-4000-8000-000000000099";
    const first = await callRoute("crm/people/dnc/route.ts", "POST", { json: { ids: [a, missing], reason: "asked" }, as: world.member });
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ marked: 1, skipped: [{ personId: missing, reason: "not_found" }] });
    const second = await callRoute("crm/people/dnc/route.ts", "POST", { json: { ids: [a], reason: "asked" }, as: world.member });
    expect(second.body).toEqual({ marked: 0, skipped: [{ personId: a, reason: "already_marked" }] });
    expect((await callRoute("crm/people/dnc/route.ts", "POST", { json: { ids: [a], reason: "" }, as: world.member })).status).toBe(422);
    expect((await callRoute("crm/people/dnc/route.ts", "POST", { json: { ids: [], reason: "asked" }, as: world.member })).status).toBe(400);
  });

  it("POST /api/companies answers 201 for a new company, 200 for a company with leads only, and 409 company_exists for a listed one", async () => {
    const domain = `globex-${tag}.test`;
    const created = await callRoute("companies/route.ts", "POST", { json: { domain: `https://www.${domain}/about`, name: "Globex" }, as: world.member });
    expect(created.status).toBe(201);
    expect(created.body).toEqual({ companyId: expect.any(String), listed: true });
    const exists = await callRoute("companies/route.ts", "POST", { json: { domain }, as: world.member });
    expect(exists.status).toBe(409);
    expect(exists.body).toEqual({ error: `Globex already uses ${domain}.`, code: "company_exists", companyId: (created.body as { companyId: string }).companyId, name: "Globex", domain, viaAlias: false });

    const [unlisted] = await world.sql`insert into companies (organization_id, domain, name) values (${world.orgA.id}, ${`initech-${tag}.test`}, 'Initech') returning id`;
    const listed = await callRoute("companies/route.ts", "POST", { json: { domain: `initech-${tag}.test` }, as: world.member });
    expect(listed.status).toBe(200);
    expect(listed.body).toEqual({ companyId: unlisted.id, listed: true });

    const webmail = await callRoute("companies/route.ts", "POST", { json: { domain: "gmail.com" }, as: world.member });
    expect(webmail.status).toBe(422);
  });

  it("GET /api/companies/resolve and /search find companies by domain and name; 422 for a domain that names no company", async () => {
    const domain = `hooli-${tag}.test`;
    await callRoute("companies/route.ts", "POST", { json: { domain, name: "Hooli" }, as: world.member });
    const resolved = await callRoute("companies/resolve/route.ts", "GET", { query: { domain: `www.${domain}` }, as: world.member });
    expect(resolved.status).toBe(200);
    expect(resolved.body).toEqual({ company: { companyId: expect.any(String), name: "Hooli", domain, viaAlias: false, listed: true } });
    const none = await callRoute("companies/resolve/route.ts", "GET", { query: { domain: `nobody-${tag}.test` }, as: world.member });
    expect(none.body).toEqual({ company: null });
    expect((await callRoute("companies/resolve/route.ts", "GET", { query: { domain: "not a domain" }, as: world.member })).status).toBe(422);

    const found = await callRoute("companies/search/route.ts", "GET", { query: { q: "hooli", all: "1" }, as: world.member });
    expect(found.status).toBe(200);
    expect(found.body).toEqual({ companies: [expect.objectContaining({ name: "Hooli", domain, listed: true })] });
  });

  it("merge preview and merge answer the preview, 200 with the moved people, 404 for a gone company and 409 same_company", async () => {
    const kept = (await callRoute("companies/route.ts", "POST", { json: { domain: `kept-${tag}.test`, name: "Kept" }, as: world.member })).body as { companyId: string };
    const [other] = await world.sql`insert into companies (organization_id, domain, name) values (${world.orgA.id}, ${`other-${tag}.test`}, 'Other') returning id`;
    await world.sql`insert into people (organization_id, full_name, email, company_id) values (${world.orgA.id}, 'Olive', ${`olive-${tag}@routes.test`}, ${other.id})`;

    const preview = await callRoute("companies/[id]/merge/preview/route.ts", "POST", { params: { id: kept.companyId }, json: { otherId: other.id }, as: world.member });
    expect(preview.status).toBe(200);
    const body = preview.body as { kept: { version: number; people: number }; other: { version: number; people: number }; moves: unknown };
    expect(body.moves).toEqual({ contacts: 0, leads: 1, openDeals: 0, deals: 0, leadsInRunningCampaigns: 0 });

    const same = await callRoute("companies/[id]/merge/preview/route.ts", "POST", { params: { id: kept.companyId }, json: { otherId: kept.companyId }, as: world.member });
    expect(same.status).toBe(409);
    expect(same.body).toEqual({ error: "Pick another company to merge.", code: "same_company" });

    const expected = { keptVersion: body.kept.version, otherVersion: body.other.version, keptPeople: body.kept.people, otherPeople: body.other.people };
    const noExpected = await callRoute("companies/[id]/merge/route.ts", "POST", { params: { id: kept.companyId }, json: { otherId: other.id }, as: world.member });
    expect(noExpected.status).toBe(422);
    const merged = await callRoute("companies/[id]/merge/route.ts", "POST", { params: { id: kept.companyId }, json: { otherId: other.id, expected }, as: world.member });
    expect(merged.status).toBe(200);
    expect(merged.body).toEqual({ companyId: kept.companyId, moved: { people: 1 } });
    const replay = await callRoute("companies/[id]/merge/route.ts", "POST", { params: { id: kept.companyId }, json: { otherId: other.id, expected }, as: world.member });
    expect(replay.body).toEqual(merged.body);
    const gone = await callRoute("companies/[id]/merge/preview/route.ts", "POST", { params: { id: kept.companyId }, json: { otherId: other.id }, as: world.member });
    expect(gone.status).toBe(404);

    const page = await callRoute("companies/[id]/route.ts", "GET", { params: { id: kept.companyId }, as: world.member });
    expect(page.body).toMatchObject({ company: { aliases: [{ domain: `other-${tag}.test`, mergedName: "Other" }], contacts: 0, leads: 1 } });
  });

  it("DELETE /api/companies/[id] answers 409 company_in_use, 409 company_changed, 422 for a bad version, 200, then 404", async () => {
    const [busy] = await world.sql`insert into companies (organization_id, domain, name) values (${world.orgA.id}, ${`busy-${tag}.test`}, 'Busy') returning id`;
    await world.sql`insert into people (organization_id, full_name, email, company_id) values (${world.orgA.id}, 'Bea', ${`bea-${tag}@routes.test`}, ${busy.id})`;
    const inUse = await callRoute("companies/[id]/route.ts", "DELETE", { params: { id: busy.id }, query: { expectedVersion: "0" }, as: world.member });
    expect(inUse.status).toBe(409);
    expect(inUse.body).toEqual({ error: "Busy still has 1 lead. Merge it into another company, or move those people first.", code: "company_in_use", contacts: 0, leads: 1 });

    const [empty] = await world.sql`insert into companies (organization_id, domain, name) values (${world.orgA.id}, ${`empty-${tag}.test`}, 'Empty') returning id`;
    expect((await callRoute("companies/[id]/route.ts", "DELETE", { params: { id: empty.id }, query: { expectedVersion: "x" }, as: world.member })).status).toBe(422);
    const changed = await callRoute("companies/[id]/route.ts", "DELETE", { params: { id: empty.id }, query: { expectedVersion: "3" }, as: world.member });
    expect(changed.status).toBe(409);
    expect(changed.body).toEqual({ error: "Empty changed while this was open. Check it and delete again.", code: "company_changed", companyId: empty.id });
    const deleted = await callRoute("companies/[id]/route.ts", "DELETE", { params: { id: empty.id }, query: { expectedVersion: "0" }, as: world.member });
    expect(deleted.status).toBe(200);
    expect(deleted.body).toEqual({ ok: true });
    expect((await callRoute("companies/[id]/route.ts", "DELETE", { params: { id: empty.id }, query: { expectedVersion: "0" }, as: world.member })).status).toBe(404);
  });
});
