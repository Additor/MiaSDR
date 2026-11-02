import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createTestOrg, describeDb, dropOrgs, testSql, useTestEnv, type TestOrg } from "@/test-support/db";
import { enableMcp, mcpCaller, type McpCaller } from "@/test-support/mcp-fixture";

vi.mock("server-only", () => ({}));
vi.mock("next/server", async (original) => (await import("@/test-support/route-client")).nextServerStandIn(await original()));

/**
 * The smallest pool `docs/deploy/self-host.md` suggests. A read from the pool while the same call holds its one
 * connection in a transaction waits forever, so each call below has to finish.
 */
describeDb("MCP calls on a one-connection pool", () => {
  useTestEnv({ DB_POOL_MAX: "1", AI_PROVIDER: "fake", MAILBOX_PROVIDER: "fake" });
  const sql = testSql({ max: 2 });
  let POST: (request: Request) => Promise<Response>;
  const orgs: TestOrg[] = [];
  let agent: McpCaller;
  let mailboxId: string;
  let personId: string;

  beforeAll(async () => {
    ({ POST } = await import("../route"));
    orgs.push(await createTestOrg(sql, "One connection"));
    const [org] = orgs;
    await enableMcp(sql, org.organizationId);
    await sql`update channel_settings set values = values || ${sql.json({ agentSendMode: "replies_and_campaigns", agentSendEpoch: 0 })} where organization_id = ${org.organizationId} and channel = 'mcp'`;
    [{ id: mailboxId }] = await sql<{ id: string }[]>`insert into mailboxes (organization_id, email_address, status) values (${org.organizationId}, ${`sdr-${randomBytes(4).toString("hex")}@corp.test`}, 'connected') returning id`;
    [{ id: personId }] = await sql<{ id: string }[]>`insert into people (organization_id, full_name, first_name, email) values (${org.organizationId}, 'Ada Lovelace', 'Ada', ${`ada-${randomBytes(4).toString("hex")}@acme.test`}) returning id`;
    agent = await mcpCaller(sql, POST, org, ["mcp:read", "mcp:write", "mcp:send"]);
  });

  afterAll(async () => {
    try {
      await dropOrgs(sql, orgs);
    } finally {
      await sql.end();
    }
  });

  it("edits steps and senders, enrolls and starts a campaign without waiting on itself", { timeout: 20_000 }, async () => {
    const created = await agent.tool("draft_campaign", { action: "create", channel: "email", name: "Pool of one" });
    const campaignId = created.structured.campaignId as string;
    const steps = [{ stepNumber: 1, kind: "email", subject: "Hi {{first_name}}", body: "A short note.", waitDays: 0 }];
    const updated = await agent.tool("draft_campaign", { action: "update", channel: "email", campaignId, steps, senderIds: [mailboxId] });
    expect(updated.isError, updated.text).toBe(false);
    const added = await agent.tool("draft_campaign", { action: "add_leads", channel: "email", campaignId, personIds: [personId] });
    expect(added.isError, added.text).toBe(false);
    const preview = await agent.tool("preview_campaign_launch", { channel: "email", campaignId, purpose: "start" });
    expect(preview.structured.problems).toEqual([]);
    const started = await agent.tool("launch_campaign", { channel: "email", campaignId, action: "start", launchToken: preview.structured.launchToken });
    expect(started.isError, started.text).toBe(false);
  });

  it("takes each action no one can undo without waiting on itself", { timeout: 30_000 }, async () => {
    const [org] = orgs;
    const { createDealForContact } = await import("@/contexts/deals/application/deal-create");
    const { dealsDeps } = await import("@/composition/deals");
    const owner = { userId: org.userId, organizationId: org.organizationId, role: "owner" };
    await sql`update channel_settings set values = values || ${sql.json({ agentIrreversiblePerDay: 20 })} where organization_id = ${org.organizationId} and channel = 'mcp'`;
    const irreversible = await mcpCaller(sql, POST, org, ["mcp:read", "mcp:write", "mcp:irreversible"]);
    const someone = async (lifecycle: "lead" | "contact") =>
      (await sql<{ id: string }[]>`insert into people (organization_id, email, full_name, lifecycle, converted_at) values (${org.organizationId}, ${`p-${randomBytes(4).toString("hex")}@acme.test`}, 'Ada', ${lifecycle}, ${lifecycle === "contact" ? new Date() : null}) returning id`)[0].id;
    const campaign = async (status: string) => (await sql<{ id: string }[]>`insert into campaigns (organization_id, channel, name, status, steps) values (${org.organizationId}, 'email', ${`C-${randomBytes(4).toString("hex")}`}, ${status}, ${sql.json([])}) returning id`)[0].id;
    const { dealId } = await createDealForContact(dealsDeps(), owner, await someone("contact"), { title: "Pool deal", idempotencyKey: `deal-${randomBytes(6).toString("hex")}` });
    const targets = [
      { kind: "delete_lead", personId: await someone("lead") },
      { kind: "delete_contact", personId: await someone("contact") },
      { kind: "delete_deal", dealId },
      { kind: "delete_draft_campaign", channel: "email", campaignId: await campaign("draft") },
      { kind: "complete_campaign", channel: "email", campaignId: await campaign("active") },
    ];
    for (const target of targets) {
      const preview = await irreversible.tool("preview_irreversible", target);
      expect(preview.isError, preview.text).toBe(false);
      const applied = await irreversible.tool("apply_irreversible", { ...target, actionToken: preview.structured.actionToken });
      expect(applied.isError, `${target.kind}: ${applied.text}`).toBe(false);
    }
  });

  it("edits and starts a LinkedIn campaign without waiting on itself", { timeout: 20_000 }, async () => {
    const [{ id: accountId }] = await sql<{ id: string }[]>`insert into linkedin_accounts (organization_id, provider_account_id, linkedin_id, name, status) values (${orgs[0].organizationId}, ${`acc-${randomBytes(4).toString("hex")}`}, ${`ACo-${randomBytes(4).toString("hex")}`}, 'Sender', 'connected') returning id`;
    const created = await agent.tool("draft_campaign", { action: "create", channel: "linkedin", name: "Pool of one, LinkedIn" });
    const campaignId = created.structured.campaignId as string;
    const steps = [{ stepNumber: 1, kind: "invitation", body: "Hello.", waitDays: 0 }];
    const updated = await agent.tool("draft_campaign", { action: "update", channel: "linkedin", campaignId, steps, senderIds: [accountId] });
    expect(updated.isError, updated.text).toBe(false);
    const preview = await agent.tool("preview_campaign_launch", { channel: "linkedin", campaignId, purpose: "start" });
    const started = await agent.tool("launch_campaign", { channel: "linkedin", campaignId, action: "start", launchToken: preview.structured.launchToken });
    expect(started.isError, started.text).toBe(false);
  });
});
