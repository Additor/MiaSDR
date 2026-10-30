import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createTestOrg, describeDb, dropOrgs, testSql, useTestEnv, type TestOrg } from "@/test-support/db";
import { enableMcp, mcpCaller, type McpCaller } from "@/test-support/mcp-fixture";
import type { Actor } from "@/shared/errors";

vi.mock("server-only", () => ({}));
vi.mock("next/server", async (original) => (await import("@/test-support/route-client")).nextServerStandIn(await original()));

describeDb("list_campaigns and get_campaign", () => {
  useTestEnv();
  const sql = testSql({ max: 3 });
  let POST: (request: Request) => Promise<Response>;
  const orgs: TestOrg[] = [];
  let caller: McpCaller;
  let emailId: string;
  let linkedinId: string;
  let foreignId: string;

  const actorOf = (org: TestOrg): Actor => ({ userId: org.userId, organizationId: org.organizationId, role: "owner" });

  beforeAll(async () => {
    ({ POST } = await import("../route"));
    const { createCampaign, enrollPickedLeads } = await import("@/contexts/outreach/application/campaign-management");
    const { campaignDeps } = await import("@/contexts/outreach/infrastructure/composition");
    const { createLinkedInCampaign } = await import("@/contexts/outreach/linkedin/application/linkedin-campaigns");
    const { linkedinCampaignDeps } = await import("@/contexts/outreach/linkedin/infrastructure/linkedin-composition");
    orgs.push(await createTestOrg(sql, "Campaigns A"), await createTestOrg(sql, "Campaigns B"));
    for (const org of orgs) await enableMcp(sql, org.organizationId);
    ({ id: emailId } = await createCampaign(campaignDeps(), actorOf(orgs[0]), { name: "Q4 email" }));
    ({ id: linkedinId } = await createLinkedInCampaign(linkedinCampaignDeps(), actorOf(orgs[0]), { name: "Q4 LinkedIn" }));
    ({ id: foreignId } = await createCampaign(campaignDeps(), actorOf(orgs[1]), { name: "Their campaign" }));
    const [{ id: personId }] = await sql<{ id: string }[]>`insert into people (organization_id, full_name, first_name, email) values (${orgs[0].organizationId}, 'Ada Lovelace', 'Ada', 'ada@acme.test') returning id`;
    await enrollPickedLeads(campaignDeps(), actorOf(orgs[0]), emailId, [personId]);
    caller = await mcpCaller(sql, POST, orgs[0]);
  });

  afterAll(async () => {
    try {
      await dropOrgs(sql, orgs);
    } finally {
      await sql.end();
    }
  });

  it("list_campaigns lists both channels of the token's organization", async () => {
    const result = await caller.tool("list_campaigns", {});
    expect(result.isError, result.text).toBe(false);
    const campaigns = result.structured.campaigns as Array<Record<string, unknown>>;
    expect(campaigns.map((c) => [c.campaignId, c.channel]).sort()).toEqual([[emailId, "email"], [linkedinId, "linkedin"]].sort());
    expect(campaigns.find((c) => c.campaignId === emailId)).toMatchObject({ enrolled: 1, status: "draft", appUrl: `http://localhost:3000/campaigns/${emailId}` });
    expect((await caller.tool("list_campaigns", { channel: "linkedin" })).structured.campaigns).toHaveLength(1);
  });

  it("get_campaign gives steps, leads and a rendered step, and answers not found across organizations", async () => {
    const result = await caller.tool("get_campaign", { channel: "email", campaignId: emailId, previewStep: 1 });
    expect(result.isError, result.text).toBe(false);
    expect(result.structured).toMatchObject({ name: "Q4 email", status: "draft", enrollments: { total: 1, page: 1 } });
    expect((result.structured.steps as unknown[]).length).toBeGreaterThan(0);
    expect(result.structured.preview).toMatchObject({ stepNumber: 1, leadName: "Ada Lovelace" });

    const linkedin = await caller.tool("get_campaign", { channel: "linkedin", campaignId: linkedinId });
    expect(linkedin.isError, linkedin.text).toBe(false);
    expect(linkedin.structured).toMatchObject({ name: "Q4 LinkedIn", enrollments: { total: 0 } });

    const foreign = await caller.tool("get_campaign", { channel: "email", campaignId: foreignId });
    expect(foreign.structured).toMatchObject({ error: { code: "not_found" } });
    const wrongChannel = await caller.tool("get_campaign", { channel: "linkedin", campaignId: emailId });
    expect(wrongChannel.isError).toBe(true);
  });
});
