import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { describeDb, testSql, useTestEnv } from "@/test-support/db";

vi.mock("server-only", () => ({}));

/** Needs TEST_DATABASE_URL pointing at a migrated Postgres. Mail goes to the server log (no RESEND_API_KEY). */
describeDb("resend verification link through Better Auth", () => {
  useTestEnv({ RESEND_API_KEY: undefined, AUTH_EMAIL_FROM: undefined });
  const sql = testSql({ max: 2 });
  const tag = Math.random().toString(36).slice(2, 8);
  const unverified = `unverified-${tag}@resend.test`;
  const verified = `verified-${tag}@resend.test`;
  let auth: typeof import("../auth").auth;
  let logged: string[] = [];

  beforeAll(async () => {
    // Better Auth rate limits only in production. Load a production-mode instance to test the limit.
    vi.stubEnv("NODE_ENV", "production");
    vi.resetModules();
    (globalThis as { __miasdrAuth?: unknown }).__miasdrAuth = undefined;
    ({ auth } = await import("../auth"));
    await sql`insert into users (name, email, email_verified) values ('Unverified', ${unverified}, false), ('Verified', ${verified}, true)`;
  });

  beforeEach(() => {
    logged = [];
    vi.spyOn(console, "log").mockImplementation((...args) => void logged.push(args.join(" ")));
  });

  afterEach(() => vi.restoreAllMocks());

  afterAll(async () => {
    vi.unstubAllEnvs();
    (globalThis as { __miasdrAuth?: unknown }).__miasdrAuth = undefined;
    await sql`delete from users where email like '%@resend.test'`;
    await sql.end();
  });

  async function resend(email: string, ip: string) {
    const response = await auth().handler(
      new Request("http://localhost:3000/api/auth/send-verification-email", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://localhost:3000", "x-forwarded-for": ip },
        body: JSON.stringify({ email, callbackURL: "/leads" }),
      }),
    );
    return { status: response.status, body: await response.text() };
  }
  const mails = () => logged.filter((entry) => entry.startsWith("[auth-email] "));

  /** The endpoint does not await the send, so wait for the mail to reach the log. */
  const mailTo = (address: string) =>
    vi.waitFor(() => {
      const mail = mails().find((entry) => entry.startsWith(`[auth-email] to=${address} `));
      if (!mail) throw new Error(`no mail to ${address} yet`);
      return mail;
    });

  it("answers the same for unverified, verified and unknown addresses, and mails only the unverified one", async () => {
    const already = await resend(verified, "10.0.0.2");
    const unknown = await resend(`nobody-${tag}@resend.test`, "10.0.0.3");
    const known = await resend(unverified, "10.0.0.1");
    expect(known.status).toBe(200);
    expect(await mailTo(unverified)).toMatch(/verify-email\?token=/);
    // The other two went first, so a mail to either would be in the log before the unverified one's.
    expect(mails().map((entry) => entry.split(" ")[1])).toEqual([`to=${unverified}`]);

    expect(already).toEqual(known);
    expect(unknown).toEqual(known);
  });

  it("limits repeated requests from one client to three per minute, whatever the address", async () => {
    const ip = "10.0.1.1";
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) statuses.push((await resend(i % 2 ? unverified : `nobody-${tag}@resend.test`, ip)).status);
    expect(statuses).toEqual([200, 200, 200, 429, 429]);
    // Another client is not affected.
    expect((await resend(unverified, "10.0.1.2")).status).toBe(200);
  });
});
