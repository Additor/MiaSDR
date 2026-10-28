import { and, eq } from "drizzle-orm";
import type { DbHandle } from "@/platform/db/client";
import { accounts, sessions, users } from "./schema";

/*
 * The writes another context needs on identity's Better Auth tables. Tenancy creates the first admin and removes members;
 * both touch users, accounts or sessions, and identity owns those rows.
 */

/**
 * A user who signs in with a password, shaped as Better Auth's own signUpEmail writes it (credential account: accountId is
 * the user id), so signing in afterwards is an ordinary sign-in. The email is verified: a new self-hoster may have no mail
 * provider yet.
 */
export async function createPasswordUserTx(tx: DbHandle, input: { name: string; email: string; passwordHash: string }): Promise<{ userId: string }> {
  const [user] = await tx.insert(users).values({ name: input.name, email: input.email, emailVerified: true }).returning({ id: users.id });
  await tx.insert(accounts).values({ userId: user.id, providerId: "credential", accountId: user.id, password: input.passwordHash });
  return { userId: user.id };
}

/** Sessions of the user that point at the organization fall back to another membership on the next sign-in. */
export async function clearActiveOrganizationTx(tx: DbHandle, userId: string, organizationId: string): Promise<void> {
  await tx.update(sessions).set({ activeOrganizationId: null }).where(and(eq(sessions.userId, userId), eq(sessions.activeOrganizationId, organizationId)));
}
