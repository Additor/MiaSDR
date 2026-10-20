import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { callRoute, createWorld, type World } from "@/test-support/route-client";
import { describeDb, dropOrgs, TEST_DATABASE_URL, useTestEnv } from "@/test-support/db";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", async () => (await import("@/test-support/route-client")).nextHeadersStandIn());
vi.mock("next/server", async (original) => (await import("@/test-support/route-client")).nextServerStandIn(await original()));

/**
 * The HTTP contract of the deal, conversion, stage and CRM list routes, as the UI calls them: status codes,
 * error codes and body shapes. The route matrix covers 401, 404 across organizations and malformed bodies for every route.
 * Needs TEST_DATABASE_URL pointing at a migrated Postgres.
 */
describeDb("deal routes", () => {
  useTestEnv();
  let world: World;

  beforeAll(async () => {
    world = await createWorld(TEST_DATABASE_URL ?? "");
  }, 120_000);

  afterAll(async () => {
    if (!world) return;
    // Throws on a failed delete; world.close() then finds nothing left of the two organizations.
    await dropOrgs(world.sql, [{ organizationId: world.orgA.id }, { organizationId: world.orgB.id }]);
    await world.close();
  });

  const lead = async (name: string, organizationId = world.orgA.id) =>
    (await world.sql`insert into people (organization_id, full_name, email) values (${organizationId}, ${name}, ${`${name.toLowerCase().replace(/\s+/g, ".")}.${Math.random().toString(36).slice(2, 6)}@routes.test`}) returning id`)[0].id as string;

  it("GET /api/deal-stages answers the defaults as virtual and writes nothing", async () => {
    const result = await callRoute("deal-stages/route.ts", "GET", { as: world.other });
    expect(result.status).toBe(200);
    expect(result.body).toEqual({
      virtual: true,
      stages: [
        { id: null, name: "New", kind: "open", position: 1, dealCount: 0 },
        { id: null, name: "Meeting", kind: "open", position: 2, dealCount: 0 },
        { id: null, name: "Proposal", kind: "open", position: 3, dealCount: 0 },
        { id: null, name: "Won", kind: "won", position: 4, dealCount: 0 },
        { id: null, name: "Lost", kind: "lost", position: 5, dealCount: 0 },
      ],
    });
    expect((await world.sql`select count(*)::int as n from deal_stages where organization_id = ${world.orgB.id}`)[0].n).toBe(0);
  });

  it("POST /api/leads/[id]/convert answers 201, a replay 200, and a second call 409 already_converted with the deal id", async () => {
    const personId = await lead("Ada Lovelace");
    const body = { idempotencyKey: "dialog-1", amount: "1250.50", currency: "USD", expectedCloseOn: "2026-12-31" };
    const created = await callRoute("leads/[id]/convert/route.ts", "POST", { params: { id: personId }, json: body, as: world.member });
    expect(created.status).toBe(201);
    expect(created.body).toEqual({ dealId: expect.any(String), stopped: { enrollments: 0, runs: 0, drafts: 0 }, replayed: false });
    const replay = await callRoute("leads/[id]/convert/route.ts", "POST", { params: { id: personId }, json: body, as: world.member });
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual({ ...(created.body as object), replayed: true });
    const again = await callRoute("leads/[id]/convert/route.ts", "POST", { params: { id: personId }, json: {}, as: world.member });
    expect(again.status).toBe(409);
    expect(again.body).toEqual({ error: "This person is already a contact.", code: "already_converted", dealId: (created.body as { dealId: string }).dealId });

    const dealId = (created.body as { dealId: string }).dealId;
    const deal = await callRoute("deals/[id]/route.ts", "GET", { params: { id: dealId }, as: world.admin });
    expect(deal.status).toBe(200);
    expect(deal.body).toMatchObject({
      id: dealId,
      title: "Ada Lovelace",
      version: 0,
      stage: { name: "New", kind: "open", position: 1 },
      owner: { userId: world.member.userId, name: "member", isMember: true },
      amountMinor: 125050,
      currency: "USD",
      expectedCloseOn: "2026-12-31",
      closedAt: null,
      lostReason: null,
      source: null,
      person: { id: personId, name: "Ada Lovelace", lifecycle: "contact", doNotContact: false, suppressed: false },
    });
    expect(await callRoute("deals/[id]/route.ts", "GET", { params: { id: dealId }, as: world.other }).then((r) => r.status)).toBe(404);
  });

  it("answers 422 for invalid input and 403 for another member's personal campaign", async () => {
    const personId = await lead("Bob Byte");
    const invalid = await callRoute("leads/[id]/convert/route.ts", "POST", { params: { id: personId }, json: { amount: "10" }, as: world.admin });
    expect(invalid.status).toBe(422);
    expect(invalid.body).toMatchObject({ error: "Pick the currency of the amount." });
    const [{ id: campaign }] = await world.sql`insert into campaigns (organization_id, channel, name, type, status, created_by) values (${world.orgA.id}, 'linkedin', 'Mine', 'personal', 'active', ${world.admin.userId}) returning id`;
    await world.sql`insert into campaign_enrollments (organization_id, campaign_id, person_id, channel, status) values (${world.orgA.id}, ${campaign}, ${personId}, 'linkedin', 'active')`;
    const refused = await callRoute("leads/[id]/convert/route.ts", "POST", { params: { id: personId }, json: {}, as: world.member });
    expect(refused.status).toBe(403);
    const preview = await callRoute("leads/convert/preview/route.ts", "POST", { json: { ids: [personId] }, as: world.member });
    expect(preview.body).toEqual({ people: 0, alreadyContacts: 0, enrollments: 0, runs: 0, followUpDraftsToRetire: 0, skippedPersonalCampaign: 1 });
    const adminPreview = await callRoute("leads/convert/preview/route.ts", "POST", { json: { ids: [personId] }, as: world.admin });
    expect(adminPreview.body).toEqual({ people: 1, alreadyContacts: 0, enrollments: 1, runs: 0, followUpDraftsToRetire: 0, skippedPersonalCampaign: 0 });
  });

  it("moves, edits and deletes a deal through its routes", async () => {
    const personId = await lead("Cy Move");
    const { dealId } = (await callRoute("leads/[id]/convert/route.ts", "POST", { params: { id: personId }, json: {}, as: world.admin })).body as { dealId: string };
    const stages = (await callRoute("deal-stages/route.ts", "GET", { as: world.admin })).body as { virtual: boolean; stages: Array<{ id: string; kind: string; name: string }> };
    expect(stages.virtual).toBe(false);
    const lost = stages.stages.find((s) => s.kind === "lost")!;
    const stale = await callRoute("deals/[id]/stage/route.ts", "POST", { params: { id: dealId }, json: { stageId: lost.id, expectedVersion: 5, lostReason: "x" }, as: world.admin });
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({ code: "stale_version", version: 0 });
    expect((await callRoute("deals/[id]/stage/route.ts", "POST", { params: { id: dealId }, json: { stageId: lost.id, expectedVersion: 0 }, as: world.admin })).status).toBe(422);
    const moved = await callRoute("deals/[id]/stage/route.ts", "POST", { params: { id: dealId }, json: { stageId: lost.id, expectedVersion: 0, lostReason: "Budget" }, as: world.admin });
    expect(moved.status).toBe(200);
    expect(moved.body).toMatchObject({ version: 1, lostReason: "Budget", stage: { id: lost.id, kind: "lost" }, closedAt: expect.any(String) });
    const patched = await callRoute("deals/[id]/route.ts", "PATCH", { params: { id: dealId }, json: { expectedVersion: 1, title: "Cy renewal", ownerId: null }, as: world.admin });
    expect(patched.body).toMatchObject({ version: 2, title: "Cy renewal", owner: null });
    expect((await callRoute("deals/[id]/route.ts", "DELETE", { params: { id: dealId }, as: world.admin })).body).toMatchObject({ code: "deal_closed" });
    const open = stages.stages.find((s) => s.kind === "open")!;
    await callRoute("deals/[id]/stage/route.ts", "POST", { params: { id: dealId }, json: { stageId: open.id, expectedVersion: 2 }, as: world.admin });
    expect((await callRoute("deals/[id]/route.ts", "DELETE", { params: { id: dealId }, query: { expectedVersion: "3" }, as: world.admin })).status).toBe(200);

    const contact = await callRoute("deals/route.ts", "POST", { json: { personId, idempotencyKey: "contact-1", title: "Second deal" }, as: world.admin });
    expect(contact.status).toBe(201);
    expect(contact.body).toEqual({ dealId: expect.any(String), replayed: false });
  });

  it("bulk conversion reports per person, and the lists answer their shapes", async () => {
    const a = await lead("Dee Bulk");
    const b = await lead("Eve Bulk");
    const foreign = await lead("Far Away", world.orgB.id);
    const report = await callRoute("leads/convert/route.ts", "POST", { json: { ids: [a, b, foreign] }, as: world.admin });
    expect(report.status).toBe(200);
    expect(report.body).toEqual({ created: [{ personId: a, dealId: expect.any(String) }, { personId: b, dealId: expect.any(String) }], skipped: [{ personId: foreign, reason: "not_found" }] });

    const board = (await callRoute("deals/route.ts", "GET", { query: { q: "Bulk" }, as: world.admin })).body as { virtual: boolean; showAll: boolean; closedSince: string; columns: Array<{ id: string; name: string; total: number; amounts: unknown[]; nextCursor: string | null; cards: Array<Record<string, unknown>> }> };
    expect(board).toMatchObject({ virtual: false, showAll: false, closedSince: expect.any(String) });
    expect(board.columns[0]).toMatchObject({ name: "New", total: 2, nextCursor: null });
    expect(board.columns[0].cards[0]).toMatchObject({ personName: "Eve Bulk", title: "Eve Bulk", owner: { userId: world.admin.userId, isMember: true }, source: null, version: 0 });

    // A bulk request takes 200 ids and no Lost stage.
    const tooMany = await callRoute("leads/convert/route.ts", "POST", { json: { ids: Array.from({ length: 201 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`) }, as: world.admin });
    expect(tooMany).toMatchObject({ status: 422, body: { error: "Create deals for up to 200 leads per request." } });
    const lostStage = board.columns.find((c) => c.name === "Lost")!;
    const intoLost = await callRoute("leads/convert/route.ts", "POST", { json: { ids: [await lead("Lost Bulk")], stageId: lostStage.id }, as: world.admin });
    expect(intoLost.status).toBe(422);
    expect((intoLost.body as { error: string }).error).toContain("Bulk cannot start deals in a Lost stage");

    // A cursor that does not decode is refused; a well-formed one past the last card answers an empty page.
    const stage = board.columns[0].id;
    for (const cursor of ["garbage", Buffer.from("not-a-date|x", "utf8").toString("base64url"), Buffer.from("2026-10-01T00:00:00Z|00000000-0000-0000-0000-00000000000g", "utf8").toString("base64url")]) {
      expect((await callRoute("deals/route.ts", "GET", { query: { stage, cursor }, as: world.admin })).status).toBe(422);
    }
    const pastEnd = Buffer.from(`1970-01-01T00:00:00.000000Z|${"0".repeat(8)}-0000-4000-8000-${"0".repeat(12)}`, "utf8").toString("base64url");
    const empty = await callRoute("deals/route.ts", "GET", { query: { stage, cursor: pastEnd }, as: world.admin });
    expect(empty.status).toBe(200);
    expect((empty.body as { columns: Array<{ cards: unknown[]; nextCursor: string | null }> }).columns).toMatchObject([{ cards: [], nextCursor: null }]);

    const contacts = await callRoute("contacts/route.ts", "GET", { query: { q: "Bulk" }, as: world.admin });
    expect(contacts.body).toMatchObject({ total: 2, page: 1, pageSize: 25, rows: [{ name: "Eve Bulk", openDeals: 1 }, { name: "Dee Bulk", openDeals: 1 }] });
    expect((await callRoute("contacts/route.ts", "GET", { query: { sort: "nope" }, as: world.admin })).status).toBe(422);
    const companies = await callRoute("companies/route.ts", "GET", { as: world.admin });
    expect(companies.status).toBe(200);
    expect(companies.body).toMatchObject({ page: 1, pageSize: 25 });
  });
});
