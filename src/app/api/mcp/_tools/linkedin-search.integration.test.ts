import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createTestOrg, describeDb, dropOrgs, testSql, useTestEnv, type TestOrg } from "@/test-support/db";
import { callMcp } from "@/test-support/mcp-client";
import { issuedCaller, type McpCaller } from "@/test-support/mcp-fixture";
import type { Actor } from "@/shared/errors";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ headers: async () => new Headers(), cookies: async () => ({ get: () => undefined, set: () => {} }) }));
vi.mock("next/server", async (original) => (await import("@/test-support/route-client")).nextServerStandIn(await original()));

const URL_OF_SEARCH = "https://www.linkedin.com/search/results/people/?keywords=cto";

/**
 * The route, then the search engine with a fake gateway. "Nobody enrolled" says nothing unless the engine ran, so these
 * run it, and count the leads it made and the account it used.
 */
describeDb("MCP agent LinkedIn search", () => {
  useTestEnv();
  const sql = testSql({ max: 6 });
  const orgs: TestOrg[] = [];
  const users: string[] = [];
  let POST: (request: Request) => Promise<Response>;
  let org: TestOrg;
  let owner: Actor;
  let agent: McpCaller;
  let tokens: typeof import("@/contexts/agent-access/application/mcp-tokens");
  let tokenDeps: import("@/contexts/agent-access/application/mcp-tokens").McpTokenDeps;

  const codeOf = (result: { structured: Record<string, unknown> }) => (result.structured.error as { code?: string } | undefined)?.code;
  const reserved = async () => (await sql<{ amount: number }[]>`select amount from mcp_agent_usage where organization_id = ${org.organizationId} and kind = 'search_leads'`)[0]?.amount ?? 0;
  const create = (args: Record<string, unknown> = {}) => agent.tool("create_linkedin_search", { name: "CTOs", url: URL_OF_SEARCH, ...args });

  async function account(ownerUserId: string | null) {
    const tag = randomBytes(4).toString("hex");
    const [{ id }] = await sql<{ id: string }[]>`
      insert into linkedin_accounts (organization_id, provider_account_id, linkedin_id, username, name, status, owner_user_id)
      values (${org.organizationId}, ${`acct-${tag}`}, ${`ACo-${tag}`}, ${`u-${tag}`}, 'Account', 'connected', ${ownerUserId}) returning id`;
    return { id, ref: `acct-${tag}` };
  }

  async function otherMember() {
    const [{ id }] = await sql<{ id: string }[]>`insert into users (name, email) values ('Other', ${`o-${randomBytes(4).toString("hex")}@search.test`}) returning id`;
    users.push(id);
    await sql`insert into members (organization_id, user_id, role) values (${org.organizationId}, ${id}, 'member')`;
    return id;
  }

  /** Runs the engine until it finds nothing due, with one page of people on the fake gateway. */
  async function runEngine(people: number) {
    const { FakeLinkedInGateway } = await import("@/contexts/outreach/linkedin/infrastructure/fake-linkedin-gateway");
    const { runNextSearchPage } = await import("@/contexts/outreach/linkedin/application/run-linkedin-search");
    const { drizzleLinkedInSearchEngineStore } = await import("@/contexts/outreach/linkedin/infrastructure/drizzle-linkedin-search-store");
    const { searchLeadSink } = await import("@/contexts/outreach/linkedin/infrastructure/search-lead-sink");
    const gateway = new FakeLinkedInGateway();
    const tag = randomBytes(3).toString("hex");
    gateway.searchPages = [{ items: Array.from({ length: people }, (_, i) => ({ identifier: `p${i}-${tag}`, profileUrl: `https://www.linkedin.com/in/p${i}-${tag}`, name: `Person${i} Tester`, headline: "CTO", location: "Berlin", networkDistance: "DISTANCE_2" })), nextCursor: null, totalEstimate: people }] as never;
    await runNextSearchPage({ store: drizzleLinkedInSearchEngineStore, gateways: gateway, sink: searchLeadSink, clock: { now: () => new Date() }, random: () => 0 } as never);
    return gateway;
  }

  beforeAll(async () => {
    ({ POST } = await import("../route"));
    tokens = await import("@/contexts/agent-access/application/mcp-tokens");
    tokenDeps = (await import("@/contexts/agent-access/infrastructure/mcp-composition")).mcpTokenDeps();
    org = await createTestOrg(sql, "Agent search");
    orgs.push(org);
    owner = { userId: org.userId, organizationId: org.organizationId, role: "owner" };
    await tokens.updateMcpSettings(tokenDeps, owner, { enabled: true });
  });

  beforeEach(async () => {
    await sql`update linkedin_search_queries set status = 'cancelled' where status in ('queued', 'running', 'paused', 'paused_limit')`;
    await sql`delete from linkedin_accounts where organization_id = ${org.organizationId}`;
    await sql`delete from mcp_agent_usage where organization_id = ${org.organizationId}`;
    await sql`update mcp_tokens set revoked_at = now() where organization_id = ${org.organizationId} and revoked_at is null`;
    await sql`delete from channel_settings where organization_id = ${org.organizationId} and channel = 'email_rules'`;
    await tokens.updateMcpSettings(tokenDeps, owner, { agentSearchLeadsPerDay: 500, agentSpendCentsPerDay: 0 });
    agent = issuedCaller(POST, await tokens.createMcpToken(tokenDeps, owner, { name: `Agent ${randomBytes(3).toString("hex")}`, access: "write", extras: ["spend"] }));
    await account(org.userId);
  });

  afterAll(async () => {
    try {
      await dropOrgs(sql, orgs, users);
    } finally {
      await sql.end();
    }
  });

  it("offers the tool only while the search limit is above 0, and keeps it apart from enrichment", async () => {
    const names = async () => ((await callMcp(POST, { era: "modern", token: agent.token, method: "tools/list" })).body as { result: { tools: Array<{ name: string }> } }).result.tools.map((x) => x.name);
    expect(await names()).toEqual(expect.arrayContaining(["create_linkedin_search", "list_linkedin_searches", "cancel_linkedin_search"]));
    expect(await names()).not.toContain("run_enrichment");
    await tokens.updateMcpSettings(tokenDeps, owner, { agentSearchLeadsPerDay: 0, agentSpendCentsPerDay: 500 });
    expect(await names()).not.toContain("create_linkedin_search");
    expect(await names()).toContain("run_enrichment");
  });

  it("refuses a campaign id in the input before anything runs", async () => {
    const [{ id: campaignId }] = await sql<{ id: string }[]>`insert into campaigns (organization_id, channel, name, status, steps) values (${org.organizationId}, 'linkedin', 'Real', 'active', ${sql.json([])}) returning id`;
    const answer = await callMcp(POST, { era: "modern", token: agent.token, method: "tools/call", params: { name: "create_linkedin_search", arguments: { name: "x", url: URL_OF_SEARCH, campaignId } } });
    const body = answer.body as { error?: { message?: string }; result?: { isError?: boolean; content?: Array<{ text: string }> } };
    expect(body.error?.message ?? body.result?.content?.[0].text).toMatch(/campaignId|unrecognized/i);
    expect(await reserved()).toBe(0);
    expect(await sql`select 1 from linkedin_search_queries where organization_id = ${org.organizationId} and target_campaign_id = ${campaignId}`).toHaveLength(0);
  });

  it("makes leads and enrolls nobody when the engine runs, and records the agent", async () => {
    const created = await create({ maxResults: 50 });
    expect(created.isError, created.text).toBe(false);
    expect(await reserved()).toBe(50);
    const searchId = created.structured.searchId as string;
    const [row] = await sql<{ created_via_token_id: string; target_campaign_id: string | null }[]>`select created_via_token_id, target_campaign_id from linkedin_search_queries where id = ${searchId}`;
    expect(row).toEqual({ created_via_token_id: agent.tokenId, target_campaign_id: null });

    await runEngine(3);
    const [{ leads_fetched }] = await sql<{ leads_fetched: number }[]>`select leads_fetched from linkedin_search_queries where id = ${searchId}`;
    expect(leads_fetched).toBe(3);
    const people = await sql<{ id: string }[]>`select r.person_id as id from linkedin_search_results r where r.query_id = ${searchId} and r.person_id is not null`;
    expect(people).toHaveLength(3);
    expect(await sql`select 1 from campaign_enrollments where person_id in ${sql(people.map((p) => p.id))}`).toHaveLength(0);
  });

  it("never uses another member's account: the batch names only the person's and unowned ones", async () => {
    const mine = (await sql<{ id: string }[]>`select id from linkedin_accounts where organization_id = ${org.organizationId}`)[0].id;
    const unowned = await account(null);
    const theirs = await account(await otherMember());
    const created = await create();
    const searchId = created.structured.searchId as string;
    const [{ account_ids }] = await sql<{ account_ids: string[] }[]>`select b.account_ids from linkedin_search_batches b join linkedin_search_queries q on q.batch_id = b.id where q.id = ${searchId}`;
    expect([...account_ids].sort()).toEqual([mine, unowned.id].sort());
    expect(account_ids).not.toContain(theirs.id);

    await runEngine(1);
    const [{ current_account_id }] = await sql<{ current_account_id: string | null }[]>`select current_account_id from linkedin_search_queries where id = ${searchId}`;
    if (current_account_id) expect(current_account_id).not.toBe(theirs.id);
    const used = await sql`select 1 from linkedin_search_queries where id = ${searchId} and leads_fetched = 1`;
    expect(used).toHaveLength(1);
  });

  it("refuses when only another member's account is connected, and gives the reservation back", async () => {
    await sql`delete from linkedin_accounts where organization_id = ${org.organizationId}`;
    await account(await otherMember());
    expect(codeOf(await create())).toBe("agent_no_search_account");
    expect(await reserved()).toBe(0);
    expect(await sql`select 1 from linkedin_search_queries where created_via_token_id = ${agent.tokenId}`).toHaveLength(0);
  });

  it("adds up against the limit, one of two at the boundary, and refuses a bad URL without counting", async () => {
    await tokens.updateMcpSettings(tokenDeps, owner, { agentSearchLeadsPerDay: 100 });
    const results = await Promise.all([create({ maxResults: 100 }), create({ maxResults: 100, name: "Other" })]);
    expect(results.map((r) => codeOf(r)).filter((c) => c === "agent_search_cap")).toHaveLength(1);
    expect(await reserved()).toBe(100);
    const over = results.find((r) => codeOf(r) === "agent_search_cap");
    expect((over?.structured.error as { retryAfterSeconds: number }).retryAfterSeconds).toBeGreaterThan(0);

    await sql`delete from mcp_agent_usage where organization_id = ${org.organizationId}`;
    expect(codeOf(await create({ url: "https://example.com/nope" }))).toBe("validation");
    expect(await reserved()).toBe(0);
  });

  it("refuses while sending is paused, and counts nothing", async () => {
    const { setSendPause } = await import("@/contexts/outreach/application/send-pause");
    const { sendPauseDeps } = await import("@/contexts/outreach/infrastructure/composition");
    await setSendPause(sendPauseDeps(), owner, { paused: true, byName: "Owner", now: new Date() });
    try {
      expect(codeOf(await create())).toBe("agent_send_paused");
      expect(await reserved()).toBe(0);
    } finally {
      await setSendPause(sendPauseDeps(), owner, { paused: false, byName: null, now: new Date() });
    }
  });

  it("cancels what an agent created, and refuses a person's search", async () => {
    const created = await create();
    const searchId = created.structured.searchId as string;
    const writer = issuedCaller(POST, await tokens.createMcpToken(tokenDeps, owner, { name: `Writer ${randomBytes(3).toString("hex")}`, access: "write" }));
    const cancelled = await writer.tool("cancel_linkedin_search", { searchId });
    expect(cancelled.isError, cancelled.text).toBe(false);
    expect(cancelled.structured.status).toBe("cancelled");

    const { createLinkedInSearch } = await import("@/contexts/outreach/linkedin/application/linkedin-search");
    const { linkedinSearchDeps } = await import("@/contexts/outreach/linkedin/infrastructure/linkedin-composition");
    const { id } = await createLinkedInSearch(linkedinSearchDeps(), owner, { name: "Mine", url: `${URL_OF_SEARCH}2` });
    expect(codeOf(await writer.tool("cancel_linkedin_search", { searchId: id }))).toBe("agent_search_not_agents");
    expect((await sql`select status from linkedin_search_queries where id = ${id}`)[0].status).toBe("queued");
    const [batch] = await sql<{ account_ids: string[] }[]>`select b.account_ids from linkedin_search_batches b join linkedin_search_queries q on q.batch_id = b.id where q.id = ${id}`;
    expect(batch.account_ids).toEqual([]);
    expect(await reserved()).toBe(100);
  });

  it("lists searches, with accounts only for an owner or admin", async () => {
    await create();
    const seen = await agent.tool("list_linkedin_searches");
    expect(seen.isError, seen.text).toBe(false);
    expect(seen.structured.searches).toEqual(expect.arrayContaining([expect.objectContaining({ status: "queued", byAgent: true, maxResults: 100 })]));
    expect((seen.structured.accounts as unknown[]).length).toBeGreaterThan(0);

    const memberId = await otherMember();
    const member = issuedCaller(POST, await tokens.createMcpToken(tokenDeps, { userId: memberId, organizationId: org.organizationId, role: "member" }, { name: "Reader" }));
    expect((await member.tool("list_linkedin_searches")).structured.accounts).toEqual([]);
  });
});
