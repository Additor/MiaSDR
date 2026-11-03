import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createTestOrg, describeDb, dropOrgs, testSql, useTestEnv, waitForLockWaiters, type TestOrg } from "@/test-support/db";
import { ConflictError, ForbiddenError, ValidationError, type Actor } from "@/shared/errors";

vi.mock("server-only", () => ({}));

describeDb("agent usage against the daily limits", () => {
  useTestEnv();
  const sql = testSql({ max: 6 });
  const orgs: TestOrg[] = [];
  const users: string[] = [];
  let org: TestOrg;
  let owner: Actor;
  let tokens: typeof import("../../application/mcp-tokens");
  let usage: typeof import("../../application/mcp-agent-usage");
  let tokenDeps: import("../../application/mcp-tokens").McpTokenDeps;
  let usageDeps: import("../../application/mcp-agent-usage").AgentUsageDeps;

  const codeOf = async (run: Promise<unknown>) => {
    const error = await run.then(
      () => null,
      (e: unknown) => e,
    );
    return error instanceof ConflictError ? error.details?.code : error;
  };
  const amountOf = async (kind: string) => {
    const [row] = await sql<{ amount: number }[]>`select amount from mcp_agent_usage where organization_id = ${org.organizationId} and kind = ${kind}`;
    return row?.amount ?? 0;
  };
  const save = (patch: Record<string, unknown>) => tokens.updateMcpSettings(tokenDeps, owner, patch);
  const newToken = async (extras: Array<"spend" | "irreversible">) => {
    const created = await tokens.createMcpToken(tokenDeps, owner, { name: `Agent ${randomBytes(3).toString("hex")}`, access: "write", extras });
    return { ...owner, via: { kind: "agent" as const, tokenId: created.id, tokenName: created.name, clientName: null } };
  };
  const reserve = (actor: Actor, kind: "spend_cents" | "search_leads" | "irreversible", amount: number, run: () => Promise<unknown> = async () => "ran") => usage.withAgentUsage(usageDeps, actor, { kind, amount }, run);

  beforeAll(async () => {
    tokens = await import("../../application/mcp-tokens");
    usage = await import("../../application/mcp-agent-usage");
    const composition = await import("../mcp-composition");
    tokenDeps = composition.mcpTokenDeps();
    usageDeps = composition.agentUsageDeps();
    org = await createTestOrg(sql, "Agent usage");
    orgs.push(org);
    owner = { userId: org.userId, organizationId: org.organizationId, role: "owner" };
    await save({ enabled: true });
  });

  beforeEach(async () => {
    await sql`delete from mcp_agent_usage where organization_id = ${org.organizationId}`;
    await sql`update mcp_tokens set revoked_at = now() where organization_id = ${org.organizationId}`;
    await save({ agentSpendCentsPerDay: 500, agentSearchLeadsPerDay: 100, agentIrreversiblePerDay: 3 });
  });

  afterAll(async () => {
    try {
      await dropOrgs(sql, orgs, users);
    } finally {
      await sql.end();
    }
  });

  it("refuses a token with these scopes while the limit is 0, and stores the scopes it asked for", async () => {
    await save({ agentIrreversiblePerDay: 0 });
    await expect(newToken(["irreversible"])).rejects.toBeInstanceOf(ForbiddenError);
    const spender = await newToken(["spend"]);
    const [row] = await sql<{ scopes: string[] }[]>`select scopes from mcp_tokens where id = ${spender.via.tokenId}`;
    expect(row.scopes).toEqual(["mcp:read", "mcp:write", "mcp:spend"]);
  });

  it("refuses a member, though members may write", async () => {
    const [{ id: userId }] = await sql<{ id: string }[]>`insert into users (name, email) values ('Mia Member', ${`u-${randomBytes(4).toString("hex")}@usage.test`}) returning id`;
    users.push(userId);
    await sql`insert into members (organization_id, user_id, role) values (${org.organizationId}, ${userId}, 'member')`;
    const member = { userId, organizationId: org.organizationId, role: "member" };
    await expect(tokens.createMcpToken(tokenDeps, member, { name: "Mine", access: "write", extras: ["spend"] })).rejects.toBeInstanceOf(ForbiddenError);
    expect((await tokens.createMcpToken(tokenDeps, member, { name: "Mine", access: "write" })).scopes).toEqual(["mcp:read", "mcp:write"]);
  });

  it("adds up within the limit and refuses past it, with the wait until midnight UTC", async () => {
    const agent = await newToken(["spend"]);
    await reserve(agent, "spend_cents", 300);
    await reserve(agent, "spend_cents", 200);
    expect(await amountOf("spend_cents")).toBe(500);
    const error = await reserve(agent, "spend_cents", 1).catch((e: ConflictError) => e);
    expect(error).toBeInstanceOf(ConflictError);
    expect((error as ConflictError).details).toMatchObject({ code: "agent_spend_cap", retryAfterSeconds: expect.any(Number) });
    expect(await amountOf("spend_cents")).toBe(500);
    expect(await codeOf(reserve(agent, "spend_cents", 501))).toBe("agent_spend_cap");
  });

  it("refuses an amount that is not a whole number above 0, and leaves the count alone", async () => {
    const agent = await newToken(["spend"]);
    await reserve(agent, "search_leads", 50);
    for (const amount of [-20, 0, 1.5]) await expect(reserve(agent, "search_leads", amount)).rejects.toBeInstanceOf(ValidationError);
    expect(await amountOf("search_leads")).toBe(50);
  });

  it("does not run an action the limit refuses", async () => {
    const agent = await newToken(["irreversible"]);
    const run = vi.fn(async () => "ran");
    expect(await codeOf(reserve(agent, "irreversible", 4, run))).toBe("agent_irreversible_cap");
    expect(run).not.toHaveBeenCalled();
  });

  it("lets one of two reservations through at the boundary", async () => {
    const agent = await newToken(["irreversible"]);
    await reserve(agent, "irreversible", 2);
    const results = await Promise.all([reserve(agent, "irreversible", 1), reserve(agent, "irreversible", 1)].map((run) => codeOf(run)));
    expect(results.filter((code) => code === "agent_irreversible_cap")).toHaveLength(1);
    expect(await amountOf("irreversible")).toBe(3);
  });

  it("gives the amount back when the action refuses, and keeps it when the action fails some other way", async () => {
    const agent = await newToken(["irreversible"]);
    await expect(reserve(agent, "irreversible", 1, async () => { throw new ConflictError("No."); })).rejects.toBeInstanceOf(ConflictError);
    expect(await amountOf("irreversible")).toBe(0);
    await expect(reserve(agent, "irreversible", 1, async () => { throw new Error("connection lost"); })).rejects.toThrow("connection lost");
    expect(await amountOf("irreversible")).toBe(1);
  });

  it("refuses a call no agent made and writes nothing", async () => {
    await expect(usage.withAgentUsage(usageDeps, owner, { kind: "irreversible", amount: 1 }, async () => "ran")).rejects.toBeInstanceOf(ForbiddenError);
    expect(await amountOf("irreversible")).toBe(0);
  });

  it("refuses a token without the scope", async () => {
    const agent = await newToken(["spend"]);
    expect(await codeOf(reserve(agent, "irreversible", 1))).toBe("agent_irreversible_off");
    const other = await newToken(["irreversible"]);
    expect(await codeOf(reserve(other, "spend_cents", 1))).toBe("agent_spend_off");
    expect(await codeOf(reserve(other, "search_leads", 1))).toBe("agent_spend_off");
  });

  it("retires spend tokens only when both limits reach 0, and keeps a new token working", async () => {
    const before = await newToken(["spend"]);
    await save({ agentSearchLeadsPerDay: 0 });
    expect(await reserve(before, "spend_cents", 1)).toBe("ran");
    expect(await codeOf(reserve(before, "search_leads", 1))).toBe("agent_spend_off");

    await save({ agentSpendCentsPerDay: 0 });
    await save({ agentSpendCentsPerDay: 500, agentSearchLeadsPerDay: 100 });
    expect(await codeOf(reserve(before, "spend_cents", 1))).toBe("agent_spend_off");
    const after = await newToken(["spend"]);
    expect(await reserve(after, "spend_cents", 1)).toBe("ran");
  });

  it("retires irreversible tokens at 0, and leaves spend tokens alone", async () => {
    const both = await newToken(["spend", "irreversible"]);
    await save({ agentIrreversiblePerDay: 0 });
    await save({ agentIrreversiblePerDay: 3 });
    expect(await codeOf(reserve(both, "irreversible", 1))).toBe("agent_irreversible_off");
    expect(await reserve(both, "spend_cents", 1)).toBe("ran");
    expect((await newToken(["irreversible"])).via.tokenId).toBeTruthy();
    expect(await reserve(await newToken(["irreversible"]), "irreversible", 1)).toBe("ran");
  });

  it("moves an epoch past every token's, so an edited settings row cannot revive one", async () => {
    await sql`update mcp_tokens set spend_epoch = 40 where id = ${(await newToken(["spend"])).via.tokenId}`;
    await save({ agentSpendCentsPerDay: 0, agentSearchLeadsPerDay: 0 });
    const [{ values }] = await sql<{ values: { agentSpendEpoch: number } }[]>`select values from channel_settings where organization_id = ${org.organizationId} and channel = 'mcp'`;
    expect(values.agentSpendEpoch).toBe(41);
  });

  it("stops a token on the next call when it is revoked or its person is demoted", async () => {
    const agent = await newToken(["irreversible"]);
    await tokens.revokeMcpToken(tokenDeps, owner, agent.via.tokenId);
    expect(await codeOf(reserve(agent, "irreversible", 1))).toBe("agent_irreversible_off");

    const live = await newToken(["irreversible"]);
    await sql`update members set role = 'member' where organization_id = ${org.organizationId} and user_id = ${org.userId}`;
    try {
      expect(await codeOf(reserve(live, "irreversible", 1))).toBe("agent_irreversible_off");
    } finally {
      await sql`update members set role = 'owner' where organization_id = ${org.organizationId} and user_id = ${org.userId}`;
    }
  });

  it("makes a limit save wait for a reservation that holds the lock", async () => {
    const lock = await sql.reserve();
    try {
      await lock`begin`;
      await lock.unsafe("select pg_advisory_xact_lock_shared(hashtextextended($1, 0))", [`agent-send:${org.organizationId}`]);
      let saved = false;
      const saving = save({ agentSpendCentsPerDay: 400 }).then(() => {
        saved = true;
      });
      await waitForLockWaiters(sql, 1, 10_000, "%pg_advisory_xact_lock%");
      expect(saved).toBe(false);
      await lock`commit`;
      await saving;
      expect(saved).toBe(true);
    } finally {
      lock.release();
    }
  });

  it("writes one audit row for a limit change", async () => {
    await save({ agentSpendCentsPerDay: 123 });
    const rows = await sql<{ meta: Record<string, unknown> }[]>`select meta from audit_log where organization_id = ${org.organizationId} and action = 'mcp.agent_action_limits' order by created_at desc limit 1`;
    expect(rows[0].meta).toMatchObject({ agentSpendCentsPerDay: 123, agentSearchLeadsPerDay: 100, agentIrreversiblePerDay: 3 });
  });
});
