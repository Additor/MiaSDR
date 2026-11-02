import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createTestOrg, describeDb, dropOrgs, testSql, useTestEnv, type TestOrg } from "@/test-support/db";
import { ForbiddenError, NotFoundError, ValidationError, type Actor } from "@/shared/errors";

describeDb("MCP tokens", () => {
  useTestEnv();
  const sql = testSql({ max: 3 });
  let tokens: typeof import("../../application/mcp-tokens");
  let deps: import("../../application/mcp-tokens").McpTokenDeps;
  let resolveAccess: typeof import("../../application/mcp-principal").resolveMcpAccess;
  let principalDeps: import("../../application/mcp-principal").McpPrincipalDeps;
  const orgs: TestOrg[] = [];
  const users: string[] = [];

  const actorOf = (org: TestOrg, userId = org.userId, role = "owner"): Actor => ({ userId, organizationId: org.organizationId, role });

  async function member(org: TestOrg, role: string) {
    const [{ id: userId }] = await sql<{ id: string }[]>`insert into users (name, email) values ('Mia Member', ${`t-${randomBytes(4).toString("hex")}@mcp.test`}) returning id`;
    users.push(userId);
    const [{ id: memberId }] = await sql<{ id: string }[]>`insert into members (organization_id, user_id, role) values (${org.organizationId}, ${userId}, ${role}) returning id`;
    return { actor: actorOf(org, userId, role), memberId };
  }

  const auditOf = (org: TestOrg, action: string) =>
    sql<{ entity_id: string | null; meta: Record<string, unknown> }[]>`select entity_id, meta from audit_log where organization_id = ${org.organizationId} and action = ${action} order by created_at`;

  beforeAll(async () => {
    tokens = await import("../../application/mcp-tokens");
    ({ resolveMcpAccess: resolveAccess } = await import("../../application/mcp-principal"));
    const composition = await import("../mcp-composition");
    deps = composition.mcpTokenDeps();
    principalDeps = composition.mcpPrincipalDeps();
    orgs.push(await createTestOrg(sql, "Tokens on"), await createTestOrg(sql, "Tokens off"));
    await tokens.updateMcpSettings(deps, actorOf(orgs[0]), { enabled: true });
  });

  afterAll(async () => {
    try {
      await dropOrgs(sql, orgs, users);
    } finally {
      await sql.end();
    }
  });

  it("creates a read token whose secret works once shown and is stored only as a hash", async () => {
    const [on] = orgs;
    const created = await tokens.createMcpToken(deps, actorOf(on), { name: "  Laptop  " });
    expect(created).toMatchObject({ name: "Laptop", scopes: ["mcp:read"], ownerUserId: on.userId, ownerName: "Tokens on Owner", hint: created.token.slice(-4), lastUsedAt: null });
    const days = (created.expiresAt!.getTime() - created.createdAt.getTime()) / 86_400_000;
    expect(Math.round(days)).toBe(90);

    const access = await resolveAccess(principalDeps, created.token);
    expect(access && "principal" in access && access.principal.tokenId).toBe(created.id);

    const listed = await tokens.listMcpTokens(deps, actorOf(on), "mine");
    expect(listed.find((t) => t.id === created.id)).not.toHaveProperty("token");
    const [row] = await sql`select token_hash from mcp_tokens where id = ${created.id}`;
    expect(row.token_hash).not.toContain(created.token.slice(9));
    const [entry] = (await auditOf(on, "mcp.token_created")).filter((a) => a.entity_id === created.id);
    expect(entry.meta).toEqual({ name: "Laptop", scopes: "mcp:read" });
    expect(JSON.stringify(entry)).not.toContain(created.token.slice(9));
  });

  it("refuses a token while the organization has MCP off, and a blank or long name", async () => {
    const [on, off] = orgs;
    await expect(tokens.createMcpToken(deps, actorOf(off), { name: "Laptop" })).rejects.toMatchObject({ details: { code: "mcp_disabled" } });
    await expect(tokens.createMcpToken(deps, actorOf(on), { name: "   " })).rejects.toBeInstanceOf(ValidationError);
    await expect(tokens.createMcpToken(deps, actorOf(on), { name: "x".repeat(101) })).rejects.toBeInstanceOf(ValidationError);
  });

  it("caps live tokens at ten per person and stops counting a revoked one", async () => {
    const [on] = orgs;
    const { actor } = await member(on, "member");
    const made = [];
    for (let i = 0; i < 10; i++) made.push(await tokens.createMcpToken(deps, actor, { name: `Agent ${i}` }));
    await expect(tokens.createMcpToken(deps, actor, { name: "Eleventh" })).rejects.toMatchObject({ details: { code: "mcp_token_limit" } });
    await tokens.revokeMcpToken(deps, actor, made[0].id);
    await expect(tokens.createMcpToken(deps, actor, { name: "Eleventh" })).resolves.toMatchObject({ name: "Eleventh" });
  });

  it("refuses a token for a person whose membership is gone", async () => {
    const [on] = orgs;
    const { actor, memberId } = await member(on, "member");
    await sql`delete from members where id = ${memberId}`;
    await expect(tokens.createMcpToken(deps, actor, { name: "Late" })).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("lets a member revoke their own token, hides other people's, and lets an admin revoke any", async () => {
    const [on] = orgs;
    const a = await member(on, "member");
    const b = await member(on, "member");
    const mine = await tokens.createMcpToken(deps, a.actor, { name: "Mine" });
    const theirs = await tokens.createMcpToken(deps, b.actor, { name: "Theirs" });

    await expect(tokens.revokeMcpToken(deps, a.actor, theirs.id)).rejects.toBeInstanceOf(NotFoundError);
    await tokens.revokeMcpToken(deps, a.actor, mine.id);
    await tokens.revokeMcpToken(deps, a.actor, mine.id);
    expect(await resolveAccess(principalDeps, mine.token)).toBeNull();
    expect((await auditOf(on, "mcp.token_revoked")).filter((e) => e.entity_id === mine.id)).toHaveLength(1);

    await tokens.revokeMcpToken(deps, actorOf(on), theirs.id);
    expect(await resolveAccess(principalDeps, theirs.token)).toBeNull();
    await expect(tokens.revokeMcpToken(deps, actorOf(on), crypto.randomUUID())).rejects.toBeInstanceOf(NotFoundError);
  });

  it("shows every member's tokens to an admin only, and revokes them all at once", async () => {
    const [on] = orgs;
    const { actor } = await member(on, "member");
    await tokens.createMcpToken(deps, actor, { name: "Before the leak" });
    await expect(tokens.listMcpTokens(deps, actor, "organization")).rejects.toBeInstanceOf(ForbiddenError);
    await expect(tokens.revokeAllMcpTokens(deps, actor)).rejects.toBeInstanceOf(ForbiddenError);

    const all = await tokens.listMcpTokens(deps, actorOf(on), "organization");
    expect(new Set(all.map((t) => t.ownerUserId)).size).toBeGreaterThan(1);
    const { revoked } = await tokens.revokeAllMcpTokens(deps, actorOf(on));
    expect(revoked).toBe(all.length);
    expect(await tokens.listMcpTokens(deps, actorOf(on), "organization")).toEqual([]);
    const [entry] = await auditOf(on, "mcp.tokens_revoked_all");
    expect(entry.meta).toEqual({ count: all.length });
  });

  it("lets an admin turn MCP on and off and refuses settings it cannot read", async () => {
    const [, off] = orgs;
    const { actor } = await member(off, "member");
    await expect(tokens.updateMcpSettings(deps, actor, { enabled: true })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(tokens.updateMcpSettings(deps, actorOf(off), { agentSendMode: "always" })).rejects.toThrow(/Agent sending must be one of/);
    await expect(tokens.updateMcpSettings(deps, actorOf(off), { agentSendEpoch: 9 })).rejects.toThrow(/not an MCP setting/);
    await expect(tokens.updateMcpSettings(deps, actorOf(off), { enabled: "yes" })).rejects.toThrow(/true or false/);

    expect(await tokens.updateMcpSettings(deps, actorOf(off), { enabled: true })).toMatchObject({ enabled: true });
    await tokens.updateMcpSettings(deps, actorOf(off), { enabled: true });
    expect(await tokens.getMcpSettings(deps, actor)).toMatchObject({ enabled: true });
    await tokens.updateMcpSettings(deps, actorOf(off), { enabled: false });
    expect((await auditOf(off, "mcp.enabled")).length).toBe(1);
    expect((await auditOf(off, "mcp.disabled")).length).toBe(1);
  });

  it("issues write tokens to members only while the organization allows it, and drops write when it stops", async () => {
    const [on] = orgs;
    const { actor } = await member(on, "member");
    const writer = await tokens.createMcpToken(deps, actor, { name: "Writer", access: "write" });
    expect(writer.scopes).toEqual(["mcp:read", "mcp:write"]);
    expect((await auditOf(on, "mcp.token_created")).some((e) => e.meta.scopes === "mcp:read mcp:write")).toBe(true);

    expect(await tokens.updateMcpSettings(deps, actorOf(on), { memberWriteTokens: false })).toMatchObject({ memberWriteTokens: false });
    expect((await auditOf(on, "mcp.member_write_off")).length).toBe(1);
    await expect(tokens.createMcpToken(deps, actor, { name: "Writer 2", access: "write" })).rejects.toThrow(/Only owners and admins/);
    expect((await tokens.createMcpToken(deps, actorOf(on), { name: "Admin writer", access: "write" })).scopes).toContain("mcp:write");
    expect((await tokens.createMcpToken(deps, actor, { name: "Reader" })).scopes).toEqual(["mcp:read"]);
    await tokens.updateMcpSettings(deps, actorOf(on), { memberWriteTokens: true });
  });
});
