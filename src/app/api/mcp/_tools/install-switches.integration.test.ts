import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createTestOrg, describeDb, dropOrgs, testSql, useTestEnv, type TestOrg } from "@/test-support/db";
import { callMcp } from "@/test-support/mcp-client";
import { issuedCaller } from "@/test-support/mcp-fixture";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ headers: async () => new Headers(), cookies: async () => ({ get: () => undefined, set: () => {} }) }));
vi.mock("next/server", async (original) => (await import("@/test-support/route-client")).nextServerStandIn(await original()));

/** In a file of its own: `env()` caches the variables for the process. */
describeDb("MCP with spending and irreversible actions off for the install", () => {
  useTestEnv({ MCP_SPEND_ENABLED: "false", MCP_IRREVERSIBLE_ENABLED: "false" });
  const sql = testSql({ max: 3 });
  const orgs: TestOrg[] = [];

  beforeAll(async () => {
    orgs.push(await createTestOrg(sql, "Install off"));
  });

  afterAll(async () => {
    try {
      await dropOrgs(sql, orgs);
    } finally {
      await sql.end();
    }
  });

  it("hides the tools from a token the organization would allow, refuses the reservation, and leaves other tools alone", async () => {
    const { POST } = await import("../route");
    const tokens = await import("@/contexts/agent-access/application/mcp-tokens");
    const { agentUsageDeps, mcpTokenDeps } = await import("@/contexts/agent-access/infrastructure/mcp-composition");
    const { withAgentUsage } = await import("@/contexts/agent-access/application/mcp-agent-usage");
    const [org] = orgs;
    const owner = { userId: org.userId, organizationId: org.organizationId, role: "owner" };
    await tokens.updateMcpSettings(mcpTokenDeps(), owner, { enabled: true, agentSpendCentsPerDay: 500, agentSearchLeadsPerDay: 100, agentIrreversiblePerDay: 5 });
    const created = await tokens.createMcpToken(mcpTokenDeps(), owner, { name: `Agent ${randomBytes(3).toString("hex")}`, access: "write", extras: ["spend", "irreversible"] });
    const listed = await callMcp(POST, { era: "modern", token: created.token, method: "tools/list" });
    const names = (listed.body as { result: { tools: Array<{ name: string }> } }).result.tools.map((t) => t.name);
    for (const hidden of ["run_enrichment", "create_linkedin_search", "preview_irreversible", "apply_irreversible"]) expect(names).not.toContain(hidden);
    expect(names).toEqual(expect.arrayContaining(["stop_enrichment", "cancel_linkedin_search", "pause_sending", "get_workspace"]));
    const called = await issuedCaller(POST, created).tool("apply_irreversible", { kind: "delete_deal", dealId: "x", actionToken: "x" }).catch((error: Error) => error);
    expect(called instanceof Error ? called.message : called.isError).toBeTruthy();

    // A call that reached the use case by another path stops at the reservation.
    const actor = { ...owner, via: { kind: "agent" as const, tokenId: created.id, tokenName: created.name, clientName: null } };
    const run = vi.fn(async () => "ran");
    for (const [kind, code] of [["spend_cents", "agent_spend_off"], ["search_leads", "agent_spend_off"], ["irreversible", "agent_irreversible_off"]] as const) {
      await expect(withAgentUsage(agentUsageDeps(), actor, { kind, amount: 1 }, run)).rejects.toMatchObject({ details: { code } });
    }
    expect(run).not.toHaveBeenCalled();

    const [{ tokens: list }] = [{ tokens: await tokens.listMcpTokens(mcpTokenDeps(), owner, "mine") }];
    expect(list.find((t) => t.id === created.id)).toMatchObject({ spends: false, irreversible: false, spendRetired: false, irreversibleRetired: false });
  });
});
