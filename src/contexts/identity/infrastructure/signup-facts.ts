import { and, asc, eq, gt, sql } from "drizzle-orm";
import { db } from "@/platform/db/client";
import { invitations, members, organizations, users } from "@/platform/db/schema";
import { mayCreateAccount, adminsTheFirstOrganization } from "../domain/signup-policy";

async function hasAnyUser(): Promise<boolean> {
  const [row] = await db.select({ id: users.id }).from(users).limit(1);
  return Boolean(row);
}

export async function canCreateAccount(email: string): Promise<boolean> {
  if (!(await hasAnyUser())) return mayCreateAccount({ hasAnyUser: false, hasPendingInvitation: false });
  const [invited] = await db
    .select({ id: invitations.id })
    .from(invitations)
    .where(
      and(
        sql`lower(${invitations.email}) = ${email.toLowerCase()}`,
        eq(invitations.status, "pending"),
        gt(invitations.expiresAt, new Date()),
      ),
    )
    .limit(1);
  return mayCreateAccount({ hasAnyUser: true, hasPendingInvitation: Boolean(invited) });
}

async function rolesInFirstOrganization(userId: string): Promise<string | null> {
  const [first] = await db.select({ id: organizations.id }).from(organizations).orderBy(asc(organizations.createdAt)).limit(1);
  if (!first) return null;
  const [membership] = await db
    .select({ role: members.role })
    .from(members)
    .where(and(eq(members.organizationId, first.id), eq(members.userId, userId)))
    .limit(1);
  return membership?.role ?? null;
}

/** Whoever runs this install: see `adminsTheFirstOrganization`. Install-wide facts such as job failures are for them only. */
export async function isInstanceOperator(userId: string): Promise<boolean> {
  return adminsTheFirstOrganization(await rolesInFirstOrganization(userId));
}

/** The organization a fresh session opens in: the one the user joined first. */
export async function initialOrganizationId(userId: string): Promise<string | null> {
  const [membership] = await db
    .select({ organizationId: members.organizationId })
    .from(members)
    .where(eq(members.userId, userId))
    .orderBy(asc(members.createdAt))
    .limit(1);
  return membership?.organizationId ?? null;
}

/** The email a pending, unexpired invitation was sent to, or null. Lets an invited person reach sign-up. */
export async function pendingInvitationEmail(invitationId: string): Promise<string | null> {
  if (!/^[0-9a-f-]{36}$/i.test(invitationId)) return null;
  const [row] = await db
    .select({ email: invitations.email })
    .from(invitations)
    .where(and(eq(invitations.id, invitationId), eq(invitations.status, "pending"), gt(invitations.expiresAt, new Date())))
    .limit(1);
  return row?.email ?? null;
}
