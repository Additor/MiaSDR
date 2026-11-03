import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createTestOrg, describeDb, dropOrgs, testSql, useTestEnv, waitForLockWaiters, type TestOrg } from "@/test-support/db";
import type { Actor } from "@/shared/errors";

describeDb("MCP principal", () => {
  useTestEnv();
  const sql = testSql({ max: 4 });
  let resolveAccess: typeof import("../../application/mcp-principal").resolveMcpAccess;
  let deps: import("../../application/mcp-principal").McpPrincipalDeps;
  let hash: (token: string) => string;
  let members: typeof import("@/contexts/tenancy/application/member-management");
  let memberStore: import("@/contexts/tenancy/application/member-management").MemberStore;
  const orgs: TestOrg[] = [];
  const users: string[] = [];

  /** The principal, or null for both a refusal and no access. */
  const resolve = async (token: string | null) => {
    const access = await resolveAccess(deps, token);
    return access && "principal" in access ? access.principal : null;
  };

  const settings = (org: TestOrg, values: Record<string, unknown>) =>
    sql`insert into channel_settings (organization_id, channel, values) values (${org.organizationId}, 'mcp', ${sql.json(values as never)})
        on conflict (organization_id, channel) do update set values = excluded.values`;

  const newToken = () => `msdr_pat_${randomBytes(32).toString("base64url")}`;

  async function seed(org: TestOrg, userId: string, patch: { revokedAt?: string; expiresAt?: string; scopes?: string[] } = {}) {
    const token = newToken();
    const [{ id }] = await sql<{ id: string }[]>`
      insert into mcp_tokens (organization_id, user_id, kind, name, token_hash, token_hint, scopes, policy_epoch, expires_at, revoked_at)
      values (${org.organizationId}, ${userId}, 'pat', 'Laptop', ${hash(token)}, ${token.slice(-4)}, ${patch.scopes ?? ["mcp:read", "mcp:write"]}, 2,
              ${patch.expiresAt ?? null}, ${patch.revokedAt ?? null})
      returning id`;
    return { token, id };
  }

  async function member(org: TestOrg, role: string) {
    const [{ id: userId }] = await sql<{ id: string }[]>`insert into users (name, email) values ('M', ${`m-${randomBytes(4).toString("hex")}@mcp.test`}) returning id`;
    users.push(userId);
    const [{ id: memberId }] = await sql<{ id: string }[]>`insert into members (organization_id, user_id, role) values (${org.organizationId}, ${userId}, ${role}) returning id`;
    return { userId, memberId };
  }

  beforeAll(async () => {
    ({ resolveMcpAccess: resolveAccess } = await import("../../application/mcp-principal"));
    const composition = await import("../mcp-composition");
    deps = composition.mcpPrincipalDeps();
    hash = composition.hashMcpToken;
    members = await import("@/contexts/tenancy/application/member-management");
    memberStore = (await import("@/contexts/tenancy/infrastructure/drizzle-member-store")).drizzleMemberStore((await import("../member-access-composition")).memberAgentAccess);
    orgs.push(await createTestOrg(sql, "MCP A"), await createTestOrg(sql, "MCP B"), await createTestOrg(sql, "MCP off"));
    await settings(orgs[0], { enabled: true });
    await settings(orgs[1], { enabled: true });
  });

  afterAll(async () => {
    try {
      await dropOrgs(sql, orgs, users);
    } finally {
      await sql.end();
    }
  });

  it("resolves a live token to its organization, owner, role and scopes, and records use", async () => {
    const [a] = orgs;
    const { token, id } = await seed(a, a.userId);
    const principal = await resolve(token);
    expect(principal).toEqual({
      tokenId: id,
      tokenName: "Laptop",
      userId: a.userId,
      organizationId: a.organizationId,
      role: "owner",
      scopes: ["mcp:read", "mcp:write"],
      policyEpoch: 2,
      expiresAt: null,
      allows: { replies: false, campaigns: false, enrichment: false, search: false, irreversible: false },
    });
    const [{ last_used_at }] = await sql`select last_used_at from mcp_tokens where id = ${id}`;
    expect(last_used_at).not.toBeNull();
  });

  it("answers null for a malformed, unknown, revoked or expired token", async () => {
    const [a] = orgs;
    expect(await resolve(null)).toBeNull();
    expect(await resolve("msdr_pat_short")).toBeNull();
    expect(await resolve(newToken())).toBeNull();
    expect(await resolve((await seed(a, a.userId, { revokedAt: new Date().toISOString() })).token)).toBeNull();
    expect(await resolve((await seed(a, a.userId, { expiresAt: new Date(Date.now() - 1000).toISOString() })).token)).toBeNull();
  });

  it("refuses a live token of an organization with MCP off and leaves its use unrecorded", async () => {
    const off = orgs[2];
    const { token, id } = await seed(off, off.userId);
    expect(await resolveAccess(deps, token)).toEqual({ refusal: "mcp_disabled" });
    const [{ last_used_at }] = await sql`select last_used_at from mcp_tokens where id = ${id}`;
    expect(last_used_at).toBeNull();
  });

  it("drops write from a member's token once the organization turns member write tokens off", async () => {
    const [, b] = orgs;
    const m = await member(b, "member");
    const { token } = await seed(b, m.userId);
    expect((await resolve(token))?.scopes).toEqual(["mcp:read", "mcp:write"]);
    await settings(b, { enabled: true, memberWriteTokens: false });
    expect((await resolve(token))?.scopes).toEqual(["mcp:read"]);
    await sql`update members set role = 'admin' where id = ${m.memberId}`;
    expect((await resolve(token))?.scopes).toEqual(["mcp:read", "mcp:write"]);
    await settings(b, { enabled: true });
  });

  it("reads the role on every call and refuses a person who is not a member of the token's organization", async () => {
    const [a, b] = orgs;
    const m = await member(a, "admin");
    const { token } = await seed(a, m.userId);
    expect((await resolve(token))?.role).toBe("admin");
    await sql`update members set role = 'member' where id = ${m.memberId}`;
    expect((await resolve(token))?.role).toBe("member");

    // A member of B holding a token issued in A after leaving A reaches nothing, not B.
    await sql`insert into members (organization_id, user_id, role) values (${b.organizationId}, ${m.userId}, 'owner')`;
    await sql`delete from members where id = ${m.memberId}`;
    expect(await resolve(token)).toBeNull();
  });

  it("revokes the removed member's tokens, so a new invitation does not revive them", async () => {
    const [a] = orgs;
    const m = await member(a, "member");
    const { token, id } = await seed(a, m.userId);
    const owner: Actor = { userId: a.userId, organizationId: a.organizationId, role: "owner" };
    await members.removeMember({ members: memberStore, invitations: { invite: async () => ({ id: "unused" }) } }, owner, m.memberId);

    const [{ revoked_at }] = await sql`select revoked_at from mcp_tokens where id = ${id}`;
    expect(revoked_at).not.toBeNull();
    await sql`insert into members (organization_id, user_id, role) values (${a.organizationId}, ${m.userId}, 'member')`;
    expect(await resolve(token)).toBeNull();
  });

  it("waits for the agent-send lock before it touches the member rows", async () => {
    const [a] = orgs;
    const m = await member(a, "member");
    const owner: Actor = { userId: a.userId, organizationId: a.organizationId, role: "owner" };
    const holder = await sql.reserve();
    let open = false;
    try {
      await holder`begin`;
      open = true;
      await holder`select pg_advisory_xact_lock(hashtextextended(${`agent-send:${a.organizationId}`}, 0))`;
      const removal = members.removeMember({ members: memberStore, invitations: { invite: async () => ({ id: "unused" }) } }, owner, m.memberId);
      await waitForLockWaiters(sql, 1, 10_000, "%pg_advisory_xact_lock%");
      const [{ still }] = await sql<{ still: number }[]>`select count(*)::int as still from members where id = ${m.memberId}`;
      expect(still).toBe(1);
      await holder`commit`;
      open = false;
      await removal;
    } finally {
      // A failed step must not return a connection to the pool inside a transaction that still holds the lock.
      if (open) await holder`rollback`;
      holder.release();
    }
    const [{ gone }] = await sql<{ gone: number }[]>`select count(*)::int as gone from members where id = ${m.memberId}`;
    expect(gone).toBe(0);
  });
});
