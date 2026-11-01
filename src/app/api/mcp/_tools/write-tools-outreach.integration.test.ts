import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
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

  afterAll(async () => {
    try {
      await dropOrgs(sql, orgs, users);
    } finally {
      await sql.end();
    }
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
