import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createTestOrg, describeDb, dropOrgs, testSql, useTestEnv, waitForLockWaiters, type TestOrg } from "@/test-support/db";
import { callMcp } from "@/test-support/mcp-client";
import { enableMcp, mcpCaller, type McpCaller } from "@/test-support/mcp-fixture";

vi.mock("server-only", () => ({}));
vi.mock("next/server", async (original) => (await import("@/test-support/route-client")).nextServerStandIn(await original()));

const SEND = ["mcp:read", "mcp:write", "mcp:send"];
const STEPS = [{ stepNumber: 1, kind: "email", subject: "Hi {{firstName}}", body: "Hello {{firstName}}, worth a chat?", waitDays: 0 }];

describeDb("MCP agent campaigns: launch and enroll", () => {
  useTestEnv({ MAILBOX_PROVIDER: "fake" });
  const sql = testSql({ max: 6 });
  let POST: (request: Request) => Promise<Response>;
  const orgs: TestOrg[] = [];
  let org: TestOrg;
  let agent: McpCaller;

  const setMcp = (values: Record<string, unknown>) =>
    sql`update channel_settings set values = values || ${sql.json(values as never)} where organization_id = ${org.organizationId} and channel = 'mcp'`;
  const codeOf = (result: { structured: Record<string, unknown> }) => (result.structured.error as { code?: string } | undefined)?.code;
  const agentActor = () => ({ userId: org.userId, organizationId: org.organizationId, role: "owner", via: { kind: "agent" as const, tokenId: agent.tokenId, tokenName: "Test agent", clientName: null } });

  async function leads(n: number) {
    const rows = await sql<{ id: string }[]>`
      insert into people (organization_id, email, first_name)
      select ${org.organizationId}, 'lead-' || g || '-' || ${randomBytes(4).toString("hex")} || '@acme.test', 'Lee' from generate_series(1, ${n}) g
      returning id`;
    return rows.map((r) => r.id);
  }

  /** A draft email campaign with real steps. */
  async function campaign() {
    const created = await agent.tool("draft_campaign", { action: "create", channel: "email", name: `Agent ${randomBytes(3).toString("hex")}` });
    expect(created.isError, created.text).toBe(false);
    const campaignId = created.structured.campaignId as string;
    const updated = await agent.tool("draft_campaign", { action: "update", channel: "email", campaignId, steps: STEPS });
    expect(updated.isError, updated.text).toBe(false);
    return campaignId;
  }

  const addLeads = (campaignId: string, personIds: string[], extra: Record<string, unknown> = {}) => agent.tool("draft_campaign", { action: "add_leads", channel: "email", campaignId, personIds, ...extra });
  const preview = (campaignId: string, purpose: string) => agent.tool("preview_campaign_launch", { channel: "email", campaignId, purpose });
  const launch = (campaignId: string, launchToken: string, action = "start") => agent.tool("launch_campaign", { channel: "email", campaignId, action, launchToken });

  beforeAll(async () => {
    ({ POST } = await import("../route"));
    org = await createTestOrg(sql, "Agent campaigns");
    orgs.push(org);
    await enableMcp(sql, org.organizationId);
    await sql`insert into mailboxes (organization_id, email_address, status) values (${org.organizationId}, ${`sdr-${org.organizationId.slice(0, 8)}@corp.test`}, 'connected')`;
    await setMcp({ agentSendMode: "replies_and_campaigns", agentSendEpoch: 0, agentEnrollCap: 200 });
    agent = await mcpCaller(sql, POST, org, SEND);
  });

  beforeEach(() => sql`delete from mcp_rate_limits where token_id = ${agent.tokenId}`);

  afterAll(async () => {
    try {
      await dropOrgs(sql, orgs);
    } finally {
      await sql.end();
    }
  });

  it("starts a campaign with the preview's token and records the agent on the campaign and its leads", async () => {
    const campaignId = await campaign();
    expect((await addLeads(campaignId, await leads(2))).structured.enroll).toMatchObject({ added: 2 });
    const enrolled = await sql`select enrolled_via_token_id from campaign_enrollments where campaign_id = ${campaignId}`;
    expect(enrolled.map((r) => r.enrolled_via_token_id)).toEqual([agent.tokenId, agent.tokenId]);

    const seen = await preview(campaignId, "start");
    expect(seen.isError, seen.text).toBe(false);
    expect(seen.structured).toMatchObject({ problems: [], pendingLeads: 2, status: "draft" });
    expect(codeOf(await launch(campaignId, "lt1.start.2.forged"))).toBe("launch_token_stale");

    const started = await launch(campaignId, seen.structured.launchToken as string);
    expect(started.isError, started.text).toBe(false);
    expect(started.structured.status).toBe("active");
    const [row] = await sql`select status, started_via_token_id from campaigns where id = ${campaignId}`;
    expect(row).toEqual({ status: "active", started_via_token_id: agent.tokenId });
  });

  it("refuses a launch after the steps changed or more leads came in since the preview", async () => {
    const steps = await campaign();
    await addLeads(steps, await leads(1));
    const before = await preview(steps, "start");
    await agent.tool("draft_campaign", { action: "update", channel: "email", campaignId: steps, steps: [{ ...STEPS[0], body: "Changed {{firstName}}" }] });
    expect(codeOf(await launch(steps, before.structured.launchToken as string))).toBe("launch_token_stale");

    const more = await campaign();
    await addLeads(more, await leads(1));
    const seen = await preview(more, "start");
    const { enrollPickedLeads } = await import("@/contexts/outreach/application/campaign-management");
    const { campaignDeps } = await import("@/contexts/outreach/infrastructure/composition");
    await enrollPickedLeads(campaignDeps(), { userId: org.userId, organizationId: org.organizationId, role: "owner" }, more, await leads(1));
    expect(codeOf(await launch(more, seen.structured.launchToken as string))).toBe("launch_token_stale");
  });

  it("adds leads to a running campaign only with an enroll token, and an agent may not change its senders", async () => {
    const campaignId = await campaign();
    await addLeads(campaignId, await leads(1));
    await launch(campaignId, (await preview(campaignId, "start")).structured.launchToken as string);

    const people = await leads(1);
    expect(codeOf(await addLeads(campaignId, people))).toBe("launch_token_stale");
    const token = (await preview(campaignId, "enroll")).structured.launchToken as string;
    const added = await addLeads(campaignId, people, { launchToken: token });
    expect(added.structured.enroll, added.text).toMatchObject({ added: 1 });

    const [mailbox] = await sql`select id from mailboxes where organization_id = ${org.organizationId}`;
    expect(codeOf(await agent.tool("draft_campaign", { action: "update", channel: "email", campaignId, senderIds: [mailbox.id] }))).toBe("agent_sender_change_active");
  });

  it("refuses a batch that would pass today's agent enroll limit, counting draft campaigns too", async () => {
    const used = (await sql<{ n: number }[]>`select count(*)::int as n from campaign_enrollments where organization_id = ${org.organizationId} and enrolled_via_token_id is not null`)[0].n;
    await setMcp({ agentEnrollCap: used + 2 });
    try {
      const campaignId = await campaign();
      const refused = await addLeads(campaignId, await leads(3));
      expect(codeOf(refused)).toBe("agent_enroll_cap");
      expect((refused.structured.error as { retryAfterSeconds: number }).retryAfterSeconds).toBeGreaterThan(0);
      expect(await sql`select 1 from campaign_enrollments where campaign_id = ${campaignId}`).toHaveLength(0);
      expect(codeOf(await addLeads(campaignId, await leads(3), { dryRun: true }))).toBe("agent_enroll_cap");

      // Two batches of two at the boundary: the agent-enroll lock lets them count one after the other.
      const [a, b] = [await campaign(), await campaign()];
      const [pa, pb] = [await leads(1), await leads(1)];
      await setMcp({ agentEnrollCap: used + 1 });
      const lock = await sql.reserve();
      try {
        await lock`begin`;
        await lock`select pg_advisory_xact_lock(hashtextextended(${`agent-enroll:${org.organizationId}`}, 0))`;
        const both = Promise.all([addLeads(a, pa), addLeads(b, pb)]);
        await waitForLockWaiters(sql, 2);
        await lock`commit`;
        const results = await both;
        expect(results.map((r) => codeOf(r) ?? "added").sort()).toEqual(["added", "agent_enroll_cap"]);
      } finally {
        lock.release();
      }
    } finally {
      await setMcp({ agentEnrollCap: 200 });
    }
  });

  it("refuses while sending is paused, and refuses starts when the organization allows replies only", async () => {
    const campaignId = await campaign();
    await addLeads(campaignId, await leads(1));
    const token = (await preview(campaignId, "start")).structured.launchToken as string;
    await sql`insert into channel_settings (organization_id, channel, values) values (${org.organizationId}, 'general', ${sql.json({ sendingPaused: { at: new Date().toISOString(), byName: "Jo" } })})
      on conflict (organization_id, channel) do update set values = channel_settings.values || excluded.values`;
    try {
      expect(codeOf(await launch(campaignId, token))).toBe("agent_send_paused");
    } finally {
      await sql`update channel_settings set values = values - 'sendingPaused' where organization_id = ${org.organizationId} and channel = 'general'`;
    }

    await setMcp({ agentSendMode: "replies" });
    try {
      const listed = (await callMcp(POST, { era: "modern", token: agent.token, method: "tools/list" })).body as { result: { tools: Array<{ name: string }> } };
      const names = listed.result.tools.map((t) => t.name);
      expect(names).toContain("send_reply");
      expect(names).not.toContain("launch_campaign");
      const { launchCampaign } = await import("@/contexts/outreach/application/agent-campaigns");
      const { agentCampaignDeps } = await import("@/contexts/outreach/infrastructure/agent-campaign-composition");
      await expect(launchCampaign(agentCampaignDeps(), agentActor(), { channel: "email", campaignId, action: "start", launchToken: token })).rejects.toMatchObject({ details: { code: "agent_campaigns_off" } });
      // A draft campaign still takes leads: the policy guards sending, not preparing.
      expect((await addLeads(campaignId, await leads(1))).structured.enroll).toMatchObject({ added: 1 });
    } finally {
      await setMcp({ agentSendMode: "replies_and_campaigns" });
    }
  });

  it("starts a Personal LinkedIn campaign only from accounts the token's person owns", async () => {
    const tag = randomBytes(4).toString("hex");
    const [{ id: account }] = await sql`
      insert into linkedin_accounts (organization_id, provider_account_id, linkedin_id, name, status)
      values (${org.organizationId}, ${`acct-${tag}`}, ${`ACo-${tag}`}, 'Jo', 'connected') returning id`;
    const created = await agent.tool("draft_campaign", { action: "create", channel: "linkedin", name: `Personal ${tag}`, personal: true });
    const campaignId = created.structured.campaignId as string;
    const steps = [{ stepNumber: 1, kind: "invitation", body: "Hi {{firstName}}", waitDays: 0 }];
    expect((await agent.tool("draft_campaign", { action: "update", channel: "linkedin", campaignId, steps })).isError).toBe(false);
    const start = (purpose = "start") => agent.tool("preview_campaign_launch", { channel: "linkedin", campaignId, purpose });

    // No senders named: an agent cannot tell whose LinkedIn would send.
    let token = (await start()).structured.launchToken as string;
    expect(codeOf(await agent.tool("launch_campaign", { channel: "linkedin", campaignId, action: "start", launchToken: token }))).toBe("agent_sender_not_owned");

    expect((await agent.tool("draft_campaign", { action: "update", channel: "linkedin", campaignId, senderIds: [account] })).isError).toBe(false);
    token = (await start()).structured.launchToken as string;
    expect(codeOf(await agent.tool("launch_campaign", { channel: "linkedin", campaignId, action: "start", launchToken: token }))).toBe("agent_sender_not_owned");

    await sql`update linkedin_accounts set owner_user_id = ${org.userId} where id = ${account}`;
    const seen = await start();
    expect(seen.structured.problems).toEqual([]);
    const started = await agent.tool("launch_campaign", { channel: "linkedin", campaignId, action: "start", launchToken: seen.structured.launchToken as string });
    expect(started.structured.status, started.text).toBe("active");
  });

  it("lists what agents started and pauses every running campaign an agent started in one step", async () => {
    const campaignId = await campaign();
    await addLeads(campaignId, await leads(1));
    await launch(campaignId, (await preview(campaignId, "start")).structured.launchToken as string);

    const { agentSendsOverview } = await import("@/read-models/agent-sends");
    const overview = await agentSendsOverview(org.organizationId, new Date());
    expect(overview.campaigns.find((c) => c.campaignId === campaignId)).toMatchObject({ status: "active", tokenName: "Test agent", enrolledByAgents: 1 });
    expect(overview.today.enrolls).toBeGreaterThan(0);

    const { pauseAgentStartedCampaigns } = await import("@/contexts/outreach/application/agent-campaigns");
    const { agentCampaignDeps } = await import("@/contexts/outreach/infrastructure/agent-campaign-composition");
    const { ForbiddenError } = await import("@/shared/errors");
    await expect(pauseAgentStartedCampaigns(agentCampaignDeps(), { userId: org.userId, organizationId: org.organizationId, role: "member" })).rejects.toBeInstanceOf(ForbiddenError);
    const { paused } = await pauseAgentStartedCampaigns(agentCampaignDeps(), { userId: org.userId, organizationId: org.organizationId, role: "owner" });
    expect(paused).toBeGreaterThan(0);
    expect(await sql`select 1 from campaigns where organization_id = ${org.organizationId} and status = 'active' and started_via_token_id is not null`).toHaveLength(0);
  });
});
