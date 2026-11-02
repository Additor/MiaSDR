import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createTestOrg, describeDb, dropOrgs, testSql, useTestEnv, type TestOrg } from "@/test-support/db";
import { enableMcp, mcpCaller, type McpCaller } from "@/test-support/mcp-fixture";
import type { Actor } from "@/shared/errors";

vi.mock("server-only", () => ({}));
vi.mock("next/server", async (original) => (await import("@/test-support/route-client")).nextServerStandIn(await original()));

const WRITE = ["mcp:read", "mcp:write"];

describeDb("MCP write tools: campaigns, pauses, deals and imports", () => {
  useTestEnv();
  const sql = testSql({ max: 3 });
  let POST: (request: Request) => Promise<Response>;
  const orgs: TestOrg[] = [];
  const users: string[] = [];
  let owner: McpCaller;
  let member: McpCaller;
  let personId: string;

  const actorOf = (org: TestOrg): Actor => ({ userId: org.userId, organizationId: org.organizationId, role: "owner" });

  beforeAll(async () => {
    ({ POST } = await import("../route"));
    orgs.push(await createTestOrg(sql, "Outreach writes"));
    const [org] = orgs;
    await enableMcp(sql, org.organizationId);
    const [{ id: userId }] = await sql<{ id: string }[]>`insert into users (name, email) values ('Mo Member', ${`mo-${randomBytes(4).toString("hex")}@mcp.test`}) returning id`;
    users.push(userId);
    await sql`insert into members (organization_id, user_id, role) values (${org.organizationId}, ${userId}, 'member')`;
    [{ id: personId }] = await sql<{ id: string }[]>`insert into people (organization_id, full_name, first_name, email) values (${org.organizationId}, 'Ada Lovelace', 'Ada', 'ada@acme.test') returning id`;
    owner = await mcpCaller(sql, POST, org, WRITE);
    member = await mcpCaller(sql, POST, { organizationId: org.organizationId, userId }, WRITE);
  });

  // The tests together write more than one minute's write limit allows.
  beforeEach(() => sql`delete from mcp_rate_limits where organization_id = ${orgs[0].organizationId}`);

  afterAll(async () => {
    try {
      await dropOrgs(sql, orgs, users);
    } finally {
      await sql.end();
    }
  });

  it("says which fields no lead has when steps are saved", async () => {
    const created = await owner.tool("draft_campaign", { action: "create", channel: "email", name: "Fields" });
    const campaignId = created.structured.campaignId as string;
    const save = (body: string) => owner.tool("draft_campaign", { action: "update", channel: "email", campaignId, steps: [{ stepNumber: 1, kind: "email", subject: "Hello", body, waitDays: 0 }] });
    const typo = await save("Hi {{first_nmae}}");
    expect(typo.isError, typo.text).toBe(false);
    expect(typo.structured.unknownFields).toEqual([{ step: 1, token: "first_nmae" }]);
    expect(typo.text).toContain("{{first_nmae}} (step 1)");
    expect((await save("Hi {{first_name}}")).structured.unknownFields).toEqual([]);
  });

  it("removes a lead from a campaign, stops its steps, and add_leads cannot bring it back", async () => {
    const created = await owner.tool("draft_campaign", { action: "create", channel: "email", name: "Remove" });
    const campaignId = created.structured.campaignId as string;
    const [{ id: lead }] = await sql<{ id: string }[]>`insert into people (organization_id, email, first_name) values (${orgs[0].organizationId}, ${`rm-${randomBytes(4).toString("hex")}@acme.test`}, 'Rae') returning id`;
    await owner.tool("draft_campaign", { action: "add_leads", channel: "email", campaignId, personIds: [lead] });
    const [{ id: enrollmentId }] = await sql<{ id: string }[]>`select id from campaign_enrollments where campaign_id = ${campaignId} and person_id = ${lead}`;

    expect((await owner.tool("draft_campaign", { action: "remove_lead", channel: "email", campaignId })).structured.error).toMatchObject({ code: "validation" });
    const removed = await owner.tool("draft_campaign", { action: "remove_lead", channel: "email", campaignId, enrollmentIds: [enrollmentId] });
    expect(removed.isError, removed.text).toBe(false);
    expect(removed.structured.removal).toEqual({ requested: 1, removed: 1, alreadyRemoved: 0, skippedFinal: 0, notFound: 0 });
    expect((await sql`select status, next_send_at from campaign_enrollments where id = ${enrollmentId}`)[0]).toMatchObject({ status: "removed", next_send_at: null });

    expect((await owner.tool("draft_campaign", { action: "remove_lead", channel: "email", campaignId, enrollmentIds: [enrollmentId] })).structured.removal).toMatchObject({ removed: 0, alreadyRemoved: 1 });
    const again = await owner.tool("draft_campaign", { action: "add_leads", channel: "email", campaignId, personIds: [lead] });
    expect(again.structured.enroll).toMatchObject({ added: 0, skipped: { removed: 1 } });
    const other = await owner.tool("draft_campaign", { action: "create", channel: "email", name: "Other" });
    expect((await owner.tool("draft_campaign", { action: "remove_lead", channel: "email", campaignId: other.structured.campaignId as string, enrollmentIds: [enrollmentId] })).structured.removal).toMatchObject({ removed: 0, notFound: 1 });
  });

  it("refuses steps that carry a body get_campaign cut", async () => {
    const created = await owner.tool("draft_campaign", { action: "create", channel: "email", name: "Long steps" });
    const campaignId = created.structured.campaignId as string;
    const long = `${"A long paragraph about the offer. ".repeat(40)}The end.`;
    const steps = [
      { stepNumber: 1, kind: "email", subject: "Hello", body: long, waitDays: 0 },
      { stepNumber: 2, kind: "email", body: "A short follow-up.", waitDays: 2 },
    ];
    expect((await owner.tool("draft_campaign", { action: "update", channel: "email", campaignId, steps })).isError).toBe(false);

    const read = await owner.tool("get_campaign", { channel: "email", campaignId, previewStep: 2 });
    const seen = read.structured.steps as Array<{ stepNumber: number; kind: string; subject: string | null; body: string; waitDays: number }>;
    const back = seen.map((s) => ({ stepNumber: s.stepNumber, kind: s.kind, ...(s.subject ? { subject: s.subject } : {}), body: s.stepNumber === 2 ? "A new follow-up." : s.body, waitDays: s.waitDays }));
    const refused = await owner.tool("draft_campaign", { action: "update", channel: "email", campaignId, steps: back });
    expect(refused.structured.error).toMatchObject({ code: "truncated_text" });
    const [{ steps: saved }] = await sql<{ steps: Array<{ body: string }> }[]>`select steps from campaigns where id = ${campaignId}`;
    expect(saved[0].body).toBe(long);

    // A changed opening, a dropped cut mark or a trimmed end is still the cut copy.
    const cut = seen[0].body;
    for (const body of [`Fresh start. ${cut.slice(20)}`, cut.slice(0, -1), `${cut.slice(0, -1)} And more of my own.`, cut.slice(0, 252)]) {
      const edited = await owner.tool("draft_campaign", { action: "update", channel: "email", campaignId, steps: [{ ...steps[0], body }, steps[1]] });
      expect(edited.structured.error, body).toMatchObject({ code: "truncated_text" });
    }
    // The whole text, read with previewStep and changed elsewhere, saves.
    const whole = (await owner.tool("get_campaign", { channel: "email", campaignId, previewStep: 1 })).structured.steps as Array<{ body: string; readToken: string | null }>;
    const changed = await owner.tool("draft_campaign", { action: "update", channel: "email", campaignId, steps: [{ ...steps[0], body: whole[0].body.replace("The end.", "The real end.") }, steps[1]] });
    expect(changed.isError, changed.text).toBe(false);

    // Text read whole may lose everything past the cut, with the token that proves the read.
    const reread = (await owner.tool("get_campaign", { channel: "email", campaignId, previewStep: 1 })).structured.steps as Array<{ body: string; readToken: string }>;
    const shortened = reread[0].body.slice(0, 200);
    const unproven = await owner.tool("draft_campaign", { action: "update", channel: "email", campaignId, steps: [{ ...steps[0], body: shortened }, steps[1]] });
    expect(unproven.structured.error).toMatchObject({ code: "truncated_text" });
    const proven = await owner.tool("draft_campaign", { action: "update", channel: "email", campaignId, steps: [{ ...steps[0], body: shortened, readToken: reread[0].readToken }, steps[1]] });
    expect(proven.isError, proven.text).toBe(false);
  });

  it("refuses a blank search, which would enroll every lead, and steps the channel cannot save", async () => {
    const campaignId = (await owner.tool("draft_campaign", { action: "create", channel: "email", name: "Careful" })).structured.campaignId as string;
    for (const query of ["", "   "]) {
      const blank = await owner.tool("draft_campaign", { action: "add_leads", channel: "email", campaignId, query });
      expect(blank.isError, query).toBe(true);
    }
    expect(await sql`select 1 from campaign_enrollments where campaign_id = ${campaignId}`).toHaveLength(0);

    const wrongKind = await owner.tool("draft_campaign", { action: "update", channel: "email", campaignId, steps: [{ stepNumber: 1, kind: "invitation", body: "Hi", waitDays: 0 }] });
    expect(wrongKind.isError).toBe(true);
    // get_campaign's null subject and tagged text come back clean.
    const tagged = await owner.tool("draft_campaign", { action: "update", channel: "email", campaignId, steps: [{ stepNumber: 1, kind: "email", subject: "<untrusted_field_ab>\nHello\n</untrusted_field_ab>", body: "Hi", waitDays: 0 }, { stepNumber: 2, kind: "email", subject: null, body: "Again", waitDays: 2 }] });
    expect(tagged.isError, tagged.text).toBe(false);
    const [{ steps }] = await sql<{ steps: Array<{ subject?: string }> }[]>`select steps from campaigns where id = ${campaignId}`;
    expect(steps[0].subject).toBe("Hello");
  });

  it("drafts a campaign, counts a dry run without enrolling, then enrolls, and refuses a running campaign", async () => {
    const created = await owner.tool("draft_campaign", { action: "create", channel: "email", name: "Agent Q4" });
    expect(created.isError, created.text).toBe(false);
    const campaignId = created.structured.campaignId as string;
    const steps = [{ stepNumber: 1, kind: "email", subject: "Hi {{first_name}}", body: "A short note.", waitDays: 0 }];
    expect((await owner.tool("draft_campaign", { action: "update", channel: "email", campaignId, steps })).isError).toBe(false);

    const dry = await owner.tool("draft_campaign", { action: "add_leads", channel: "email", campaignId, personIds: [personId], dryRun: true });
    expect(dry.structured.enroll).toMatchObject({ dryRun: true, wouldAdd: 1, added: 0 });
    expect(await sql`select 1 from campaign_enrollments where campaign_id = ${campaignId}`).toHaveLength(0);
    const added = await owner.tool("draft_campaign", { action: "add_leads", channel: "email", campaignId, personIds: [personId] });
    expect(added.structured.enroll).toMatchObject({ dryRun: false, added: 1 });

    await sql`update campaigns set status = 'active' where id = ${campaignId}`;
    const running = await owner.tool("draft_campaign", { action: "add_leads", channel: "email", campaignId, query: "acme" });
    // A write token cannot send, so a running campaign takes no leads from it.
    expect(running.structured.error).toMatchObject({ code: "agent_campaigns_off" });
    const senders = await owner.tool("draft_campaign", { action: "update", channel: "email", campaignId, senderIds: [] });
    expect(senders.structured.error).toMatchObject({ code: "agent_sender_change_active" });

    expect((await owner.tool("pause_sending", { target: "campaign", channel: "email", campaignId })).structured.outcome).toBe("paused");
    expect((await owner.tool("pause_sending", { target: "campaign", channel: "email", campaignId })).structured.outcome).toBe("already_paused");
    const { id: draftId } = await (await import("@/contexts/outreach/application/campaign-management")).createCampaign((await import("@/contexts/outreach/infrastructure/composition")).campaignDeps(), actorOf(orgs[0]), { name: "Not started" });
    expect((await owner.tool("pause_sending", { target: "campaign", channel: "email", campaignId: draftId })).structured.outcome).toBe("not_started");
  });

  it("pauses the organization for an owner's agent only, and names the agent on the banner", async () => {
    const refused = await member.tool("pause_sending", { target: "organization" });
    expect(refused.structured.error).toMatchObject({ code: "forbidden" });
    expect((await owner.tool("pause_sending", { target: "organization" })).structured.outcome).toBe("paused");
    expect((await owner.tool("pause_sending", { target: "organization" })).structured.outcome).toBe("already_paused");
    const [general] = await sql<{ values: { sendingPaused: { byName: string } } }[]>`select values from channel_settings where organization_id = ${orgs[0].organizationId} and channel = 'general'`;
    const [{ name }] = await sql<{ name: string }[]>`select name from users where id = ${orgs[0].userId}`;
    expect(general.values.sendingPaused.byName).toBe(`${name}'s agent (Test agent)`);
    const [{ id: recordId }] = await sql<{ id: string }[]>`select gen_random_uuid() as id`;
    expect((await owner.tool("pause_sending", { target: "follow_ups", recordId })).structured.error).toMatchObject({ code: "not_found" });
  });

  it("moves a deal with the version it read and refuses a stale one", async () => {
    const { createDealForContact } = await import("@/contexts/deals/application/deal-create");
    const { dealsDeps } = await import("@/composition/deals");
    await sql`update people set lifecycle = 'contact', converted_at = now() where id = ${personId}`;
    const { dealId } = await createDealForContact(dealsDeps(), actorOf(orgs[0]), personId, { title: "Acme seats", idempotencyKey: `deal-${randomBytes(6).toString("hex")}` });
    const [{ version }] = await sql<{ version: number }[]>`select version from deals where id = ${dealId}`;
    const [stage] = await sql<{ id: string }[]>`select id from deal_stages where organization_id = ${orgs[0].organizationId} and kind = 'open' order by position desc limit 1`;
    const board = (await owner.tool("get_pipeline", { dealId })).structured.deal as { title: string };
    expect(board.title).toMatch(/^<untrusted_field_/);
    const moved = await owner.tool("update_deal", { action: "move_stage", dealId, stageId: stage.id, expectedVersion: version });
    expect(moved.isError, moved.text).toBe(false);
    expect(moved.structured).toMatchObject({ dealId, stage: { stageId: stage.id }, appUrl: `http://localhost:3000/crm/deals/${dealId}` });
    const [event] = await sql<{ meta: Record<string, unknown> }[]>`select meta from events where person_id = ${personId} and event_type in ('deal.stage_moved', 'deal.updated') order by created_at desc limit 1`;
    expect(event.meta).toMatchObject({ dealId, via: { tokenId: owner.tokenId } });
    const stale = await owner.tool("update_deal", { action: "edit", dealId, expectedVersion: version, title: "Acme 40 seats" });
    expect(stale.structured.error).toMatchObject({ code: "stale_version" });
  });

  it("previews an import, commits it once with the token, and refuses the token to anyone else or twice", async () => {
    const csvText = "Email,First name,Company\nbea@beta.test,Bea,Beta\nada@acme.test,Ada,Acme\n";
    const mapping = { Email: "email", "First name": "first_name", Company: "company_name" };
    const preview = await owner.tool("import_leads", { action: "preview", csvText, mapping });
    expect(preview.isError, preview.text).toBe(false);
    expect(preview.structured.summary).toMatchObject({ totalRows: 2, created: 1 });
    const previewToken = preview.structured.previewToken as string;

    expect((await member.tool("import_leads", { action: "commit", previewToken })).structured.error).toMatchObject({ code: "preview_expired" });
    const second = await owner.tool("import_leads", { action: "preview", csvText, mapping });
    const committed = await owner.tool("import_leads", { action: "commit", previewToken: second.structured.previewToken });
    expect(committed.isError, committed.text).toBe(false);
    expect(committed.structured.report).toMatchObject({ stats: { created: 1 } });
    expect(await sql`select 1 from people where organization_id = ${orgs[0].organizationId} and email = 'bea@beta.test'`).toHaveLength(1);
    expect((await owner.tool("import_leads", { action: "commit", previewToken: second.structured.previewToken })).structured.error).toMatchObject({ code: "preview_expired" });

    const tooMany = await owner.tool("import_leads", { action: "preview", csvText: `Email\n${Array.from({ length: 501 }, (_, i) => `p${i}@x.test`).join("\n")}`, mapping: { Email: "email" } });
    expect(tooMany.text).toContain("500 rows");
  });
});
