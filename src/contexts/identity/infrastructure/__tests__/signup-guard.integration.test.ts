import { hashPassword } from "better-auth/crypto";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { describeDb, dropOrgs, testSql, useTestEnv } from "@/test-support/db";

vi.mock("server-only", () => ({}));

/**
 * Needs TEST_DATABASE_URL pointing at a migrated, disposable Postgres: the first test empties `users`.
 * The instance is invite-only and APP_URL has a trailing slash, as an operator might type it.
 */
describeDb("sign-up guard on an invite-only instance", () => {
  useTestEnv({ APP_URL: "http://localhost:3000/", AUTH_SIGNUP: "invite-only", RESEND_API_KEY: undefined, AUTH_EMAIL_FROM: undefined });
  const sql = testSql({ max: 2 });
  const tag = Math.random().toString(36).slice(2, 8);
  const owner = { email: `owner-${tag}@guard.test`, password: "owner-password-1" };
  let auth: typeof import("../auth").auth;
  let setupInstance: typeof import("@/contexts/tenancy/application/setup-instance").setupInstance;
  let drizzleSetupStore: typeof import("@/contexts/tenancy/infrastructure/drizzle-setup-store").drizzleSetupStore;
  let organizationId = "";
  let ownerId = "";

  beforeAll(async () => {
    ({ auth } = await import("../auth"));
    ({ setupInstance } = await import("@/contexts/tenancy/application/setup-instance"));
    ({ drizzleSetupStore } = await import("@/contexts/tenancy/infrastructure/drizzle-setup-store"));
  });

  afterEach(() => vi.restoreAllMocks());

  afterAll(async () => {
    // Setup creates the organization; it goes with the users this file signed up.
    const orgs = await sql<{ organizationId: string }[]>`select id as "organizationId" from organizations where name = ${`Guard ${tag}`}`;
    await dropOrgs(sql, orgs);
    await sql`delete from users where email like '%@guard.test'`;
    await sql.end();
  });

  it("refuses a Better Auth sign-up while no user exists, then setup creates the owner who can sign in", async () => {
    await sql`delete from users`;
    // With email verification required, Better Auth answers a refused sign-up like an accepted one (no account probing).
    // The proof of refusal is that no row exists afterwards.
    const early = await auth().api.signUpEmail({ body: { name: "Early", email: `early-${tag}@guard.test`, password: "early-password-1" } });
    expect(early.token).toBeNull();
    const [{ n }] = await sql`select count(*)::int as n from users`;
    expect(n).toBe(0);

    const created = await setupInstance(
      { store: drizzleSetupStore, hashPassword },
      { name: "Owner", email: owner.email, password: owner.password, organizationName: `Guard ${tag}`, timeZone: "europe/berlin" },
    );
    ownerId = created.userId;
    organizationId = created.organizationId;
    const signedIn = await auth().api.signInEmail({ body: owner });
    expect(signedIn.user.email).toBe(owner.email);
    const [{ values }] = await sql`select values from channel_settings where organization_id = ${organizationId} and channel = 'general'`;
    expect(values).toEqual({ timeZone: "Europe/Berlin" });
  });

  it("refuses a Google sign-up without an invitation and accepts one with a pending invitation", async () => {
    const context = await auth().$context;
    const googleUser = (email: string) =>
      context.internalAdapter.createOAuthUser(
        { name: "Google Person", email, emailVerified: true },
        { providerId: "google", accountId: `g-${email}`, accessToken: "token" },
      );

    await expect(googleUser(`stranger-${tag}@guard.test`)).rejects.toMatchObject({ statusCode: 403 });
    expect(await sql`select 1 from users where email = ${`stranger-${tag}@guard.test`}`).toHaveLength(0);

    const invited = `invited-${tag}@guard.test`;
    await sql`insert into invitations (organization_id, email, role, status, expires_at, inviter_id)
      values (${organizationId}, ${invited}, 'member', 'pending', now() + interval '1 day', ${ownerId})`;
    const created = await googleUser(invited);
    expect(created.user.email).toBe(invited);
  });

  it("refuses a sign-up whose only invitation expired or was canceled, and hides it from the sign-up page", async () => {
    const context = await auth().$context;
    const { pendingInvitationEmail } = await import("../signup-facts");
    const cases = [
      { email: `expired-${tag}@guard.test`, status: "pending", expiresIn: "-1 minute" },
      { email: `canceled-${tag}@guard.test`, status: "canceled", expiresIn: "1 day" },
    ];
    for (const c of cases) {
      const [{ id }] = await sql`insert into invitations (organization_id, email, role, status, expires_at, inviter_id)
        values (${organizationId}, ${c.email}, 'member', ${c.status}, now() + ${c.expiresIn}::interval, ${ownerId}) returning id`;
      expect(await pendingInvitationEmail(id)).toBeNull();
      const signup = context.internalAdapter.createOAuthUser(
        { name: "Google Person", email: c.email, emailVerified: true },
        { providerId: "google", accountId: `g-${c.email}`, accessToken: "token" },
      );
      await expect(signup).rejects.toMatchObject({ statusCode: 403 });
      expect(await sql`select 1 from users where email = ${c.email}`).toHaveLength(0);
    }
  });

  it("builds the invitation link without a double slash when APP_URL ends in a slash", async () => {
    const logged: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args) => void logged.push(args.join(" ")));
    const { headers } = await auth().api.signInEmail({ body: owner, returnHeaders: true });
    const cookie = headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
    await auth().api.createInvitation({
      body: { email: `link-${tag}@guard.test`, role: "member", organizationId },
      headers: new Headers({ cookie }),
    });
    // The invitation mail is not awaited, so wait for it to reach the log.
    const mail = await vi.waitFor(() => {
      const found = logged.find((entry) => entry.startsWith(`[auth-email] to=link-${tag}@guard.test `));
      if (!found) throw new Error("no invitation mail yet");
      return found;
    });
    expect(mail).toMatch(/http:\/\/localhost:3000\/accept-invitation\/[0-9a-f-]{36}/);
    expect(mail).not.toContain("3000//");
  });

  it("the setup route answers 400 with the first validation message", async () => {
    const { POST } = await import("@/app/api/setup/route");
    const post = (body: unknown) =>
      POST(new Request("http://localhost/api/setup", { method: "POST", body: JSON.stringify(body) }));
    const base = { name: "Ada", email: "ada@guard.test", password: "long-enough-1", organizationName: "Acme" };

    const zone = await post({ ...base, timeZone: "Mars/Olympus" });
    expect(zone.status).toBe(400);
    expect(await zone.json()).toEqual({ error: "Time zone is not a known IANA zone.", code: "bad_request" });

    const password = await post({ ...base, password: "short" });
    expect(await password.json()).toEqual({ error: "Password needs at least 8 characters.", code: "bad_request" });

    expect((await post(base)).status).toBe(409);
  });
});
