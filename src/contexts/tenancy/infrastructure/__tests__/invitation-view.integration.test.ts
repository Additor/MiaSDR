import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { callRoute, createWorld, type Identity, type World } from "@/test-support/route-client";
import { describeDb, TEST_DATABASE_URL } from "@/test-support/db";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", async () => (await import("@/test-support/route-client")).nextHeadersStandIn());
vi.mock("next/server", async (original) => (await import("@/test-support/route-client")).nextServerStandIn(await original()));

/** Needs TEST_DATABASE_URL pointing at a migrated Postgres. */
const ROUTE = "invitations/[id]/route.ts";
const PASSWORD = "invitee-pw-12345";

describeDb("invitation view and decline", () => {
  let world: World;
  let authRoute: typeof import("@/app/api/auth/[...all]/route");
  let invitee: Identity;
  let stranger: Identity;
  const tag = Math.random().toString(36).slice(2, 8);

  /** A verified user with a password and no organization, like a person who just signed up from the invitation link. */
  async function newcomer(name: string): Promise<Identity> {
    const { auth } = await import("@/contexts/identity/infrastructure/auth");
    const email = `${name}-${tag}@matrix.test`;
    const hash = await (await auth().$context).password.hash(PASSWORD);
    const [{ id }] = await world.sql<{ id: string }[]>`insert into users (name, email, email_verified) values (${name}, ${email}, true) returning id`;
    await world.sql`insert into accounts (user_id, provider_id, account_id, password) values (${id}, 'credential', ${id}, ${hash})`;
    const signedIn = await auth().api.signInEmail({ body: { email, password: PASSWORD }, returnHeaders: true });
    const cookie = signedIn.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
    return { name, userId: id, email, cookie, organizationId: "", role: "" };
  }

  async function invite(overrides: { status?: string; expiresInDays?: number; email?: string; role?: string } = {}) {
    const [{ id }] = await world.sql<{ id: string }[]>`
      insert into invitations (organization_id, email, role, status, expires_at, inviter_id)
      values (${world.orgA.id}, ${overrides.email ?? invitee.email}, ${overrides.role ?? "admin"}, ${overrides.status ?? "pending"},
              now() + ${String(overrides.expiresInDays ?? 7)} * interval '1 day', ${world.admin.userId})
      returning id`;
    return id;
  }

  const view = (id: string, as: Identity | null) => callRoute(ROUTE, "GET", { params: { id }, as });
  const post = (path: string, as: Identity, body: unknown) =>
    authRoute.POST(
      new Request(`http://localhost:3000/api/auth/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://localhost:3000", cookie: as.cookie },
        body: JSON.stringify(body),
      }),
    );
  const statusOf = async (id: string) => (await world.sql`select status from invitations where id = ${id}`)[0].status as string;
  const memberships = async (userId: string) => (await world.sql`select count(*)::int as n from members where user_id = ${userId}`)[0].n as number;

  beforeAll(async () => {
    world = await createWorld(TEST_DATABASE_URL ?? "");
    authRoute = await import("@/app/api/auth/[...all]/route");
    invitee = await newcomer("invitee");
    stranger = await newcomer("stranger");
  }, 120_000);
  afterAll(async () => world?.close());

  it("shows the invited person the organization, role, inviter name and expiry", async () => {
    const id = await invite();
    const result = await view(id, invitee);
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      state: "ready",
      organizationName: expect.stringContaining("Matrix a"),
      role: "admin",
      inviterName: world.admin.name,
      viewerEmail: invitee.email,
    });
    expect(new Date((result.body as { expiresAt: string }).expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it("matches the invited address in any letter case", async () => {
    const id = await invite({ email: invitee.email.toUpperCase() });
    expect((await view(id, invitee)).body).toMatchObject({ state: "ready" });
  });

  it("shows another account the organization name only, in every invitation status", async () => {
    const cases = [{}, { status: "accepted" }, { status: "rejected" }, { expiresInDays: -2 }];
    for (const overrides of cases) {
      const id = await invite(overrides);
      for (const viewer of [stranger, world.member]) {
        const result = await view(id, viewer);
        expect(result.status).toBe(200);
        expect(result.body, JSON.stringify(overrides)).toEqual({ state: "wrong-account", organizationName: expect.stringContaining("Matrix a"), viewerEmail: viewer.email });
        for (const secret of [invitee.email, world.admin.email, world.admin.name, id, "admin"]) expect(result.text, `${secret} ${JSON.stringify(overrides)}`).not.toContain(secret);
      }
    }
  });

  it("answers expired, used and declined to the invited person", async () => {
    expect((await view(await invite({ expiresInDays: -1 }), invitee)).body).toMatchObject({ state: "expired", organizationName: expect.any(String) });
    expect((await view(await invite({ status: "accepted" }), invitee)).body).toMatchObject({ state: "used" });
    expect((await view(await invite({ status: "rejected" }), invitee)).body).toMatchObject({ state: "declined" });
  });

  it("answers 404 not-found for a canceled invitation, an unknown id and a non-uuid id", async () => {
    const canceled = await view(await invite({ status: "canceled" }), invitee);
    expect(canceled.status).toBe(404);
    expect(canceled.body).toEqual({ state: "not-found" });
    expect((await view("00000000-0000-4000-8000-000000000000", invitee)).status).toBe(404);
    for (const bad of ["not-a-uuid", "x", "1; drop table invitations"]) expect((await view(bad, invitee)).status, bad).toBe(404);
  });

  it("answers 401 without a session", async () => {
    expect((await view(await invite(), null)).status).toBe(401);
  });

  it("serves the page a minimal anonymous view and not-found for a bad id", async () => {
    const { getInvitationView } = await import("../../application/invitation-view");
    const { drizzleInvitationReader } = await import("../drizzle-invitation-reader");
    const deps = { invitations: drizzleInvitationReader };
    const id = await invite();
    const anonymous = await getInvitationView(deps, { invitationId: id, viewerEmail: null });
    expect(anonymous).toEqual({ state: "anonymous", organizationName: expect.stringContaining("Matrix a"), viewerEmail: null });
    expect(JSON.stringify(anonymous)).not.toContain(invitee.email);
    expect(await getInvitationView(deps, { invitationId: "nope", viewerEmail: null })).toEqual({ state: "not-found" });
  });

  it("declines through Better Auth, shows declined, and refuses a later accept", async () => {
    const id = await invite();
    const decline = await post("organization/reject-invitation", invitee, { invitationId: id });
    expect(decline.status).toBe(200);
    expect(await statusOf(id)).toBe("rejected");
    expect((await view(id, invitee)).body).toMatchObject({ state: "declined" });

    const accept = await post("organization/accept-invitation", invitee, { invitationId: id });
    expect(accept.status).toBeGreaterThanOrEqual(400);
    expect(accept.status).toBeLessThan(500);
    expect(await statusOf(id)).toBe("rejected");
    expect(await memberships(invitee.userId)).toBe(0);
  });

  it("refuses a decline from another account and leaves the invitation pending", async () => {
    const id = await invite();
    const decline = await post("organization/reject-invitation", stranger, { invitationId: id });
    expect(decline.status).toBeGreaterThanOrEqual(400);
    expect(decline.status).toBeLessThan(500);
    expect(await statusOf(id)).toBe("pending");
  });

  it("accepting makes the invitation used and the person a member", async () => {
    const joiner = await newcomer("joiner");
    const id = await invite({ email: joiner.email, role: "member" });
    expect((await post("organization/accept-invitation", joiner, { invitationId: id })).status).toBe(200);
    expect((await view(id, joiner)).body).toMatchObject({ state: "used" });
    expect(await memberships(joiner.userId)).toBe(1);
  });
});
