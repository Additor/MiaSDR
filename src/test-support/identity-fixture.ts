import type postgres from "postgres";
import type { Identity } from "./route-client";

const PASSWORD = "identity-fixture-pw-1";

/** Sets the environment a route-level integration test needs. Call before the first import of app code. */
export function useTestEnvironment(databaseUrl: string, signup: "open" | "invite-only"): void {
  const secret = "i".repeat(40);
  Object.assign(process.env, {
    DATABASE_URL: databaseUrl,
    DATABASE_SSL: "disable",
    APP_URL: "http://localhost:3000",
    BETTER_AUTH_SECRET: secret,
    INTEGRATION_CREDENTIALS_KEY: secret,
    UNSUBSCRIBE_SECRET: secret,
    AUTH_SIGNUP: signup,
  });
  delete process.env.RESEND_API_KEY;
  delete process.env.AUTH_EMAIL_FROM;
}

/**
 * A verified user with a credential account and a real Better Auth session cookie. `memberships` are joined in
 * order, so the first one is the user's oldest and the session opens there. Pass none for a user without an organization.
 */
export async function signedInUser(
  sql: ReturnType<typeof postgres>,
  name: string,
  memberships: Array<{ organizationId: string; role: string }> = [],
): Promise<Identity> {
  const { auth } = await import("@/contexts/identity/infrastructure/auth");
  const email = `${name}@identity-fixture.test`;
  const hash = await (await auth().$context).password.hash(PASSWORD);
  const [{ id }] = await sql<{ id: string }[]>`insert into users (name, email, email_verified) values (${name}, ${email}, true) returning id`;
  await sql`insert into accounts (user_id, provider_id, account_id, password) values (${id}, 'credential', ${id}, ${hash})`;
  for (const m of memberships) {
    await sql`insert into members (organization_id, user_id, role) values (${m.organizationId}, ${id}, ${m.role})`;
    // members.created_at defaults to now(); a tick apart keeps "oldest" unambiguous.
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const signedIn = await auth().api.signInEmail({ body: { email, password: PASSWORD }, returnHeaders: true });
  const cookie = signedIn.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  if (!cookie) throw new Error(`sign-in for ${email} returned no cookie`);
  return { name, userId: id, email, cookie, organizationId: memberships[0]?.organizationId ?? "", role: memberships[0]?.role ?? "" };
}
