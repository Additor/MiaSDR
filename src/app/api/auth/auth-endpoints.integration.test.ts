import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { describeDb, TEST_DATABASE_URL, useTestEnv } from "@/test-support/db";
import { createWorld, type World } from "@/test-support/route-client";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", async () => (await import("@/test-support/route-client")).nextHeadersStandIn());
vi.mock("next/server", async (original) => (await import("@/test-support/route-client")).nextServerStandIn(await original()));

/** Every organization endpoint that changes state, as the plugin mounts it. Only accept-invitation and reject-invitation stay open. */
const REFUSED = [
  "create", "update", "delete", "set-active", "leave", "check-slug",
  "invite-member", "cancel-invitation", "remove-member", "update-member-role",
  "create-role", "update-role", "delete-role",
  "create-team", "update-team", "remove-team", "set-active-team", "add-team-member", "remove-team-member",
];

describeDb("/api/auth organization endpoints", () => {
  // createWorld writes these variables; listing them here puts them back after the file.
  const secret = "r".repeat(40);
  useTestEnv({
    BETTER_AUTH_SECRET: secret,
    INTEGRATION_CREDENTIALS_KEY: secret,
    UNSUBSCRIBE_SECRET: secret,
    CRON_SECRET: "cron-secret-for-matrix",
    MAILBOX_PROVIDER: "fake",
    LINKEDIN_PROVIDER: "fake",
    AI_PROVIDER: "fake",
    GRID_PROVIDER: "fake",
    AUTH_SIGNUP: "invite-only",
    RESEND_API_KEY: undefined,
    AUTH_EMAIL_FROM: undefined,
  });
  let world: World;
  let route: typeof import("./[...all]/route");

  beforeAll(async () => {
    world = await createWorld(TEST_DATABASE_URL ?? "");
    route = await import("./[...all]/route");
  });
  afterAll(async () => world?.close());

  const post = (path: string, cookie: string | null, body: unknown = {}) =>
    route.POST(
      new Request(`http://localhost:3000/api/auth/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://localhost:3000", ...(cookie ? { cookie } : {}) },
        body: JSON.stringify(body),
      }),
    );

  it("answers 403 to an owner, a member and a visitor, and changes nothing", async () => {
    const { orgA, admin, member } = world;
    const snapshot = async () =>
      JSON.stringify([
        await world.sql`select name, slug from organizations where id = ${orgA.id}`,
        await world.sql`select id, role from members where organization_id = ${orgA.id} order by id`,
        await world.sql`select count(*)::int as n from invitations where organization_id = ${orgA.id}`,
      ]);
    const [{ id: memberRowId }] = await world.sql`select id from members where organization_id = ${orgA.id} and user_id = ${member.userId}`;
    const before = await snapshot();
    const bodies: Record<string, unknown> = {
      update: { organizationId: orgA.id, data: { name: "Hijacked" } },
      delete: { organizationId: orgA.id },
      "invite-member": { email: "x@matrix.test", role: "owner", organizationId: orgA.id },
      "remove-member": { memberIdOrEmail: admin.email, organizationId: orgA.id },
      "update-member-role": { memberId: memberRowId, role: "owner", organizationId: orgA.id },
    };
    for (const path of REFUSED) {
      for (const who of [admin.cookie, member.cookie, null]) {
        const response = await post(`organization/${path}`, who, bodies[path]);
        expect(response.status, `${path} as ${who === null ? "visitor" : who === admin.cookie ? "owner" : "member"}`).toBe(403);
        expect(await response.json()).toMatchObject({ code: "AUTH_ENDPOINT_NOT_ALLOWED" });
      }
    }
    expect(await snapshot()).toBe(before);
  });

  it("keeps the flows the app uses working", async () => {
    const session = await route.GET(new Request("http://localhost:3000/api/auth/get-session", { headers: { cookie: world.admin.cookie } }));
    expect(session.status).toBe(200);
    // Not allow-listed would be 403. A missing invitation id is Better Auth's own answer, so the request passed the gate.
    const accept = await post("organization/accept-invitation", world.member.cookie, { invitationId: "00000000-0000-4000-8000-000000000000" });
    expect(accept.status).not.toBe(403);
    expect(accept.status).toBeLessThan(500);
    const signIn = await post("sign-in/email", null, { email: world.admin.email, password: "wrong-password" });
    expect(signIn.status).toBe(401);
  });

  it("refuses the plugin calls from server code through the hooks and the deletion switch", async () => {
    const { auth } = await import("@/contexts/identity/infrastructure/auth");
    const headers = new Headers({ cookie: world.admin.cookie });
    const [{ id: memberRowId }] = await world.sql`select id from members where organization_id = ${world.orgA.id} and user_id = ${world.member.userId}`;
    await expect(auth().api.updateMemberRole({ headers, body: { memberId: memberRowId, role: "owner", organizationId: world.orgA.id } })).rejects.toMatchObject({ statusCode: 403 });
    await expect(auth().api.deleteOrganization({ headers, body: { organizationId: world.orgA.id } })).rejects.toMatchObject({ statusCode: 404 });
    await expect(auth().api.removeMember({ headers, body: { memberIdOrEmail: world.member.email, organizationId: world.orgA.id } })).rejects.toMatchObject({ statusCode: 403 });
    await expect(auth().api.updateOrganization({ headers, body: { organizationId: world.orgA.id, data: { name: "Hijacked" } } })).rejects.toMatchObject({ statusCode: 403 });
    const [row] = await world.sql`select role from members where organization_id = ${world.orgA.id} and user_id = ${world.member.userId}`;
    expect(row.role).toBe("member");
    const [org] = await world.sql`select id from organizations where id = ${world.orgA.id}`;
    expect(org).toBeTruthy();
  });
});
