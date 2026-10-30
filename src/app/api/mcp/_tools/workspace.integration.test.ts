import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createTestOrg, describeDb, dropOrgs, testSql, useTestEnv, type TestOrg } from "@/test-support/db";
import { callMcp } from "@/test-support/mcp-client";
import { enableMcp, mcpCaller, type McpCaller } from "@/test-support/mcp-fixture";

vi.mock("server-only", () => ({}));
vi.mock("next/server", async (original) => (await import("@/test-support/route-client")).nextServerStandIn(await original()));

describeDb("get_workspace", () => {
  useTestEnv();
  const sql = testSql({ max: 3 });
  let POST: (request: Request) => Promise<Response>;
  const orgs: TestOrg[] = [];
  let caller: McpCaller;

  beforeAll(async () => {
    ({ POST } = await import("../route"));
    orgs.push(await createTestOrg(sql, "Workspace A"), await createTestOrg(sql, "Workspace B"));
    for (const org of orgs) await enableMcp(sql, org.organizationId);
    await sql`insert into mailboxes (organization_id, email_address, display_name, status) values (${orgs[0].organizationId}, 'sdr@a.test', 'Sam', 'connected')`;
    await sql`insert into mailboxes (organization_id, email_address, display_name, status) values (${orgs[1].organizationId}, 'sdr@b.test', 'Bo', 'connected')`;
    caller = await mcpCaller(sql, POST, orgs[0]);
  });

  afterAll(async () => {
    try {
      await dropOrgs(sql, orgs);
    } finally {
      await sql.end();
    }
  });

  it("lists itself in tools/list as a read-only tool", async () => {
    const result = await callMcp(POST, { era: "modern", token: caller.token, method: "tools/list" });
    const tools = (result.body as { result: { tools: Array<{ name: string; annotations: Record<string, unknown> }> } }).result.tools;
    expect(tools.find((t) => t.name === "get_workspace")?.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: false });
  });

  it("answers the token's organization only, in both protocol eras", async () => {
    for (const era of ["modern", "legacy"] as const) {
      const result = await caller.tool("get_workspace", {}, era);
      expect(result.isError, result.text).toBe(false);
      expect(result.structured.members).toEqual([expect.objectContaining({ userId: orgs[0].userId, role: "owner" })]);
      expect(result.structured.mailboxes).toEqual([expect.objectContaining({ emailAddress: "sdr@a.test", status: "connected" })]);
      expect(JSON.stringify(result.structured)).not.toContain("sdr@b.test");
      expect(result.text).toContain("Members (1)");
    }
  });
});
