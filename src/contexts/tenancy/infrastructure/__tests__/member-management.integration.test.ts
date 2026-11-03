import { afterAll, beforeAll, expect, it } from "vitest";
import type { Actor } from "@/shared/errors";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/shared/errors";
import { describeDb, dropOrgs, testSql, useTestEnv } from "@/test-support/db";

/** Needs TEST_DATABASE_URL pointing at a migrated Postgres. */
describeDb("member management", () => {
  useTestEnv();
  const sql = testSql({ max: 3 });
  let uc: typeof import("../../application/member-management");
  let store: typeof import("../drizzle-member-store");
  let agentAccess: import("../../application/member-management").MemberAgentAccess;
  const orgs: string[] = [];

  async function user(tag: string) {
    const [{ id }] = await sql`insert into users (name, email) values (${"U " + tag}, ${tag + "@members.test"}) returning id`;
    return id as string;
  }

  /** The gateway stands in for Better Auth: it writes the invitation row the plugin would write. */
  async function org() {
    const tag = Math.random().toString(36).slice(2, 8);
    const [{ id: orgId }] = await sql`insert into organizations (name, slug) values ('M', ${"mem-" + tag}) returning id`;
    orgs.push(orgId);
    const join = async (name: string, role: string) => {
      const userId = await user(`${name}-${tag}`);
      const [{ id: memberId }] = await sql`insert into members (organization_id, user_id, role) values (${orgId}, ${userId}, ${role}) returning id`;
      const actor: Actor = { userId, organizationId: orgId, role };
      return { userId, memberId: memberId as string, actor };
    };
    const owner = await join("owner", "owner");
    const deps: import("../../application/member-management").MemberDeps = {
      members: store.drizzleMemberStore(agentAccess),
      invitations: {
        async invite(actor, input) {
          const [{ id }] = await sql`insert into invitations (organization_id, email, role, expires_at, inviter_id) values (${actor.organizationId}, ${input.email}, ${input.role}, now() + interval '7 days', ${actor.userId}) returning id`;
          return { id };
        },
      },
    };
    return { orgId, tag, owner, join, deps };
  }

  beforeAll(async () => {
    uc = await import("../../application/member-management");
    store = await import("../drizzle-member-store");
    ({ memberAgentAccess: agentAccess } = await import("@/contexts/agent-access/infrastructure/member-access-composition"));
  });

  afterAll(async () => {
    await dropOrgs(sql, orgs.map((organizationId) => ({ organizationId })));
    await sql`delete from users where email like '%@members.test'`;
    await sql.end();
  });

  it("lets any member read the list, and only admins read invitations", async () => {
    const t = await org();
    const member = await t.join("m", "member");
    expect(await uc.listMembers(t.deps, member.actor)).toHaveLength(2);
    await expect(uc.listInvitations(t.deps, member.actor)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("invites with a normalized email, lists the pending invitation and revokes it", async () => {
    const t = await org();
    const { id } = await uc.inviteMember(t.deps, t.owner.actor, { email: `  New.${t.tag}@Members.test `, role: "member" });
    const pending = await uc.listInvitations(t.deps, t.owner.actor);
    expect(pending).toEqual([expect.objectContaining({ id, email: `new.${t.tag}@members.test`, role: "member", status: "pending" })]);
    await uc.revokeInvitation(t.deps, t.owner.actor, id);
    expect(await uc.listInvitations(t.deps, t.owner.actor)).toEqual([]);
    await expect(uc.revokeInvitation(t.deps, t.owner.actor, id)).rejects.toBeInstanceOf(ConflictError);
  });

  it("validates invitations and refuses existing members, members and admins granting owner", async () => {
    const t = await org();
    const admin = await t.join("a", "admin");
    const member = await t.join("m", "member");
    await expect(uc.inviteMember(t.deps, member.actor, { email: "x@y.test", role: "member" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(uc.inviteMember(t.deps, admin.actor, { email: "x@y.test", role: "owner" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(uc.inviteMember(t.deps, admin.actor, { email: "x@y.test", role: "root" })).rejects.toBeInstanceOf(ValidationError);
    await expect(uc.inviteMember(t.deps, admin.actor, { email: "nope", role: "member" })).rejects.toBeInstanceOf(ValidationError);
    await expect(uc.inviteMember(t.deps, admin.actor, { email: `Owner-${t.tag}@members.test`, role: "member" })).rejects.toBeInstanceOf(ConflictError);
    await expect(uc.inviteMember(t.deps, admin.actor, { email: "ok@y.test", role: "admin" })).resolves.toHaveProperty("id");
  });

  it("protects the last owner from demotion and removal", async () => {
    const t = await org();
    const admin = await t.join("a", "admin");
    await expect(uc.changeMemberRole(t.deps, t.owner.actor, t.owner.memberId, "admin")).rejects.toBeInstanceOf(ForbiddenError);
    await expect(uc.removeMember(t.deps, admin.actor, t.owner.memberId)).rejects.toBeInstanceOf(ForbiddenError);
    // A second owner makes the first one free to step down.
    await uc.changeMemberRole(t.deps, t.owner.actor, admin.memberId, "owner");
    await uc.changeMemberRole(t.deps, t.owner.actor, t.owner.memberId, "admin");
    const roles = Object.fromEntries((await uc.listMembers(t.deps, t.owner.actor)).map((m) => [m.id, m.role]));
    expect(roles).toEqual({ [t.owner.memberId]: "admin", [admin.memberId]: "owner" });
    // The remaining owner is the last one again.
    await expect(uc.changeMemberRole(t.deps, { ...admin.actor, role: "owner" }, admin.memberId, "member")).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("keeps admins from touching owners or granting owner, and stops self-removal", async () => {
    const t = await org();
    const admin = await t.join("a", "admin");
    const member = await t.join("m", "member");
    await expect(uc.changeMemberRole(t.deps, admin.actor, member.memberId, "owner")).rejects.toBeInstanceOf(ForbiddenError);
    await uc.changeMemberRole(t.deps, admin.actor, member.memberId, "admin");
    await expect(uc.changeMemberRole(t.deps, member.actor, admin.memberId, "member")).rejects.toBeInstanceOf(ForbiddenError);
    await expect(uc.removeMember(t.deps, admin.actor, admin.memberId)).rejects.toBeInstanceOf(ConflictError);
    await uc.removeMember(t.deps, admin.actor, member.memberId);
    expect((await uc.listMembers(t.deps, t.owner.actor)).map((m) => m.id)).not.toContain(member.memberId);
  });

  it("keeps admins from demoting or removing an owner when a second owner exists", async () => {
    const t = await org();
    const second = await t.join("o2", "owner");
    const admin = await t.join("a", "admin");
    await expect(uc.changeMemberRole(t.deps, admin.actor, t.owner.memberId, "member")).rejects.toBeInstanceOf(ForbiddenError);
    await expect(uc.removeMember(t.deps, admin.actor, t.owner.memberId)).rejects.toBeInstanceOf(ForbiddenError);
    const roles = Object.fromEntries((await uc.listMembers(t.deps, t.owner.actor)).map((m) => [m.id, m.role]));
    expect(roles).toEqual({ [t.owner.memberId]: "owner", [second.memberId]: "owner", [admin.memberId]: "admin" });
  });

  it("writes an audit row for the MCP tokens a removal revokes", async () => {
    const t = await org();
    const member = await t.join("m", "member");
    await sql`insert into mcp_tokens (organization_id, user_id, kind, name, token_hash, token_hint, scopes)
              values (${t.orgId}, ${member.userId}, 'pat', 'Agent', ${`hash-${member.userId}`}, 'abcd', ${["mcp:read"]})`;
    await uc.removeMember(t.deps, t.owner.actor, member.memberId);
    const [row] = await sql<{ actor_user_id: string; entity_id: string; meta: { count: number } }[]>`select actor_user_id, entity_id, meta from audit_log where organization_id = ${t.orgId} and action = 'mcp.member_tokens_revoked'`;
    expect(row).toEqual({ actor_user_id: t.owner.userId, entity_id: member.userId, meta: { count: 1 } });
  });

  it("clears the removed member's active organization on their sessions", async () => {
    const t = await org();
    const member = await t.join("m", "member");
    await sql`insert into sessions (expires_at, token, user_id, active_organization_id) values (now() + interval '1 day', ${"tok-" + t.tag}, ${member.userId}, ${t.orgId})`;
    await uc.removeMember(t.deps, t.owner.actor, member.memberId);
    const [row] = await sql`select active_organization_id from sessions where token = ${"tok-" + t.tag}`;
    expect(row.active_organization_id).toBeNull();
  });

  it("clears the LinkedIn accounts a removed member owned in the removal's transaction", async () => {
    const t = await org();
    const member = await t.join("li", "member");
    const [{ id: accountId }] = await sql`insert into linkedin_accounts (organization_id, provider_account_id, linkedin_id, username, status, owner_user_id) values (${t.orgId}, ${"pa-" + t.tag}, ${"li-" + t.tag}, ${"u-" + t.tag}, 'connected', ${member.userId}) returning id`;
    const { releaseLinkedInAccounts } = await import("@/contexts/outreach/linkedin/infrastructure/linkedin-composition");
    await uc.removeMember({ ...t.deps, released: releaseLinkedInAccounts }, t.owner.actor, member.memberId);
    expect(await sql`select owner_user_id from linkedin_accounts where id = ${accountId}`).toEqual([{ owner_user_id: null }]);

    // A failing release rolls the removal back, so the member and the owner stay together.
    const other = await t.join("li2", "member");
    await sql`update linkedin_accounts set owner_user_id = ${other.userId} where id = ${accountId}`;
    const failing = { ...t.deps, released: () => Promise.reject(new Error("release failed")) };
    await expect(uc.removeMember(failing, t.owner.actor, other.memberId)).rejects.toThrow("release failed");
    expect(await sql`select 1 from members where id = ${other.memberId}`).toHaveLength(1);
  });

  it("answers 404 for ids from another organization", async () => {
    const a = await org();
    const b = await org();
    const { id } = await uc.inviteMember(b.deps, b.owner.actor, { email: `x${b.tag}@y.test`, role: "member" });
    await expect(uc.changeMemberRole(a.deps, a.owner.actor, b.owner.memberId, "member")).rejects.toBeInstanceOf(NotFoundError);
    await expect(uc.removeMember(a.deps, a.owner.actor, b.owner.memberId)).rejects.toBeInstanceOf(NotFoundError);
    await expect(uc.revokeInvitation(a.deps, a.owner.actor, id)).rejects.toBeInstanceOf(NotFoundError);
    expect(await uc.listInvitations(b.deps, b.owner.actor)).toHaveLength(1);
  });

  it("lets only one of two concurrent demotions of two owners succeed", async () => {
    const t = await org();
    const second = await t.join("o2", "owner");
    const results = await Promise.allSettled([
      uc.changeMemberRole(t.deps, t.owner.actor, second.memberId, "member"),
      uc.changeMemberRole(t.deps, second.actor, t.owner.memberId, "member"),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const owners = (await uc.listMembers(t.deps, t.owner.actor)).filter((m) => m.role === "owner");
    expect(owners).toHaveLength(1);
  });
});
