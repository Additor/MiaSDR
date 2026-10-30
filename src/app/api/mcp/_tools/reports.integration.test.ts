import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createTestOrg, describeDb, dropOrgs, testSql, useTestEnv, type TestOrg } from "@/test-support/db";
import { enableMcp, mcpCaller, type McpCaller } from "@/test-support/mcp-fixture";

vi.mock("server-only", () => ({}));
vi.mock("next/server", async (original) => (await import("@/test-support/route-client")).nextServerStandIn(await original()));

describeDb("get_analytics, get_pipeline and get_sending_health", () => {
  useTestEnv();
  const sql = testSql({ max: 3 });
  let POST: (request: Request) => Promise<Response>;
  const orgs: TestOrg[] = [];
  const users: string[] = [];
  let owner: McpCaller;
  let member: McpCaller;

  beforeAll(async () => {
    ({ POST } = await import("../route"));
    orgs.push(await createTestOrg(sql, "Reports"));
    const [org] = orgs;
    await enableMcp(sql, org.organizationId);
    await sql`insert into mailboxes (organization_id, email_address, status, last_error) values (${org.organizationId}, 'broken@corp.test', 'failed', 'Gmail refused the token')`;
    const [{ id: userId }] = await sql<{ id: string }[]>`insert into users (name, email) values ('Mo Member', ${`mo-${randomBytes(4).toString("hex")}@mcp.test`}) returning id`;
    users.push(userId);
    await sql`insert into members (organization_id, user_id, role) values (${org.organizationId}, ${userId}, 'member')`;
    owner = await mcpCaller(sql, POST, org);
    member = await mcpCaller(sql, POST, { organizationId: org.organizationId, userId });
  });

  afterAll(async () => {
    try {
      await dropOrgs(sql, orgs, users);
    } finally {
      await sql.end();
    }
  });

  it("get_analytics answers a report for the last 30 days and refuses a malformed date", async () => {
    const result = await owner.tool("get_analytics", { view: "campaigns" });
    expect(result.isError, result.text).toBe(false);
    expect(result.structured).toMatchObject({ view: "campaigns", timeZone: expect.any(String), data: expect.any(Object) });
    const refused = await owner.tool("get_analytics", { view: "campaigns", from: "yesterday" });
    expect(refused.isError).toBe(true);
    expect(refused.structured).toMatchObject({ error: { code: "validation" } });
  });

  it("get_pipeline answers the default stages of an organization without deals, and not found for an unknown deal", async () => {
    const result = await owner.tool("get_pipeline", {});
    expect(result.isError, result.text).toBe(false);
    const columns = result.structured.columns as Array<{ total: number; deals: unknown[] }>;
    expect(columns.length).toBeGreaterThan(0);
    expect(columns.every((c) => c.total === 0 && c.deals.length === 0)).toBe(true);
    const missing = await owner.tool("get_pipeline", { dealId: crypto.randomUUID() });
    expect(missing.structured).toMatchObject({ error: { code: "not_found" } });
  });

  it("get_sending_health names the failed mailbox, shows a member everything but the AI job failures", async () => {
    const asOwner = await owner.tool("get_sending_health", {});
    expect(asOwner.isError, asOwner.text).toBe(false);
    expect(asOwner.text).toContain("Mailbox broken@corp.test is failed.");
    expect(asOwner.structured.failedAiJobs).toEqual({ total: 0, latest: [] });

    const asMember = await member.tool("get_sending_health", {});
    expect(asMember.isError, asMember.text).toBe(false);
    expect(asMember.structured.failedAiJobs).toBe("omitted");
    expect(asMember.structured.mailboxes).toEqual([expect.objectContaining({ emailAddress: "broken@corp.test", lastError: "Gmail refused the token" })]);
  });
});
