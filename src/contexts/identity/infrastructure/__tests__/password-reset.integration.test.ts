import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { describeDb, testSql, useTestEnv } from "@/test-support/db";

vi.mock("server-only", () => ({}));

/** Needs TEST_DATABASE_URL pointing at a migrated Postgres. Mail goes to the server log (no RESEND_API_KEY). */
describeDb("password reset through Better Auth", () => {
  useTestEnv({ RESEND_API_KEY: undefined, AUTH_EMAIL_FROM: undefined });
  const sql = testSql({ max: 2 });
  const tag = Math.random().toString(36).slice(2, 8);
  const email = `reset-${tag}@reset.test`;
  const oldPassword = "old-password-1";
  let auth: typeof import("../auth").auth;
  let logged: string[] = [];

  beforeAll(async () => {
    ({ auth } = await import("../auth"));
    const ctx = await auth().$context;
    const [{ id }] = await sql`insert into users (name, email, email_verified) values ('Reset Tester', ${email}, true) returning id`;
    await sql`insert into accounts (user_id, provider_id, account_id, password) values (${id}, 'credential', ${id}, ${await ctx.password.hash(oldPassword)})`;
  });

  beforeEach(() => {
    logged = [];
    vi.spyOn(console, "log").mockImplementation((...args) => void logged.push(args.join(" ")));
  });

  afterEach(() => vi.restoreAllMocks());

  afterAll(async () => {
    await sql`delete from users where email like '%@reset.test'`;
    await sql.end();
  });

  const requestReset = (address: string) => auth().api.requestPasswordReset({ body: { email: address, redirectTo: "/reset-password" } });
  const mails = () => logged.filter((entry) => entry.startsWith("[auth-email] "));

  /** The endpoint does not await the send, so wait for the mail to reach the log. */
  const tokenMailedTo = (address: string) =>
    vi.waitFor(() => {
      const mail = mails().find((entry) => entry.startsWith(`[auth-email] to=${address} `));
      const token = mail?.match(/\/reset-password\/([A-Za-z0-9]+)\?/)?.[1];
      if (!token) throw new Error(`no reset link mailed to ${address} yet`);
      return token;
    });

  const sessionCount = async () => (await sql`select count(*)::int as n from sessions s join users u on u.id = s.user_id where u.email = ${email}`)[0].n as number;
  const signIn = (password: string) => auth().api.signInEmail({ body: { email, password } });

  it("answers the same for a known and an unknown address, and mails only the known one", async () => {
    const unknown = await requestReset(`nobody-${tag}@reset.test`);
    const known = await requestReset(email);
    expect(await tokenMailedTo(email)).toMatch(/^[A-Za-z0-9]{24,}$/);
    // The unknown address went first, so a mail to it would be in the log before the known one's.
    expect(mails().map((entry) => entry.split(" ")[1])).toEqual([`to=${email}`]);
    expect(unknown).toEqual(known);
  });

  it("resets once, revokes sessions, and rejects the old password and a reused token", async () => {
    const signedIn = await signIn(oldPassword);
    expect(signedIn.user.email).toBe(email);
    expect(await sessionCount()).toBe(1);

    await requestReset(email);
    const token = await tokenMailedTo(email);
    await auth().api.resetPassword({ body: { token, newPassword: "new-password-2" } });

    expect(await sessionCount()).toBe(0);
    await expect(signIn(oldPassword)).rejects.toMatchObject({ body: { code: "INVALID_EMAIL_OR_PASSWORD" } });
    expect((await signIn("new-password-2")).user.email).toBe(email);

    // Single use: the token was consumed.
    await expect(auth().api.resetPassword({ body: { token, newPassword: "third-password-3" } })).rejects.toMatchObject({ body: { code: "INVALID_TOKEN" } });
    expect((await signIn("new-password-2")).user.email).toBe(email);
  });

  it("rejects an unknown token and an expired one", async () => {
    await expect(auth().api.resetPassword({ body: { token: "does-not-exist", newPassword: "new-password-2" } })).rejects.toMatchObject({ body: { code: "INVALID_TOKEN" } });

    await requestReset(email);
    const token = await tokenMailedTo(email);
    await sql`update verifications set expires_at = now() - interval '1 minute' where identifier = ${"reset-password:" + token}`;
    await expect(auth().api.resetPassword({ body: { token, newPassword: "expired-password-4" } })).rejects.toMatchObject({ body: { code: "INVALID_TOKEN" } });
  });

  it("rejects a password under the minimum length", async () => {
    await requestReset(email);
    const token = await tokenMailedTo(email);
    await expect(auth().api.resetPassword({ body: { token, newPassword: "short" } })).rejects.toMatchObject({ body: { code: "PASSWORD_TOO_SHORT" } });
  });
});
