import { and, asc, eq, gt, sql } from "drizzle-orm";
import { db } from "@/platform/db/client";
import { env } from "@/shared/env";
import { invitations, members, organizations, users } from "@/platform/db/schema";
import {
  mayCreateAccount,
  adminsTheFirstOrganization,
  mayCreateOrganization,
  publicSignupAvailable,
} from "../domain/signup-policy";

async function hasAnyUser(): Promise<boolean> {
  const [row] = await db.select({ id: users.id }).from(users).limit(1);
  return Boolean(row);
}

export async function canCreateAccount(email: string): Promise<boolean> {
  const mode = env().AUTH_SIGNUP;
  const anyUser = await hasAnyUser();
  if (!anyUser || mode === "open") return mayCreateAccount({ mode, hasAnyUser: anyUser, hasPendingInvitation: false });
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
  return mayCreateAccount({ mode, hasAnyUser: anyUser, hasPendingInvitation: Boolean(invited) });
}

export async function isPublicSignupAvailable(): Promise<boolean> {
  return publicSignupAvailable({ mode: env().AUTH_SIGNUP, hasAnyUser: await hasAnyUser() });
}

async function rolesInFirstOrganization(userId: string): Promise<{ organizationExists: boolean; roles: string | null }> {
  const [first] = await db.select({ id: organizations.id }).from(organizations).orderBy(asc(organizations.createdAt)).limit(1);
  if (!first) return { organizationExists: false, roles: null };
  const [membership] = await db
    .select({ role: members.role })
    .from(members)
    .where(and(eq(members.organizationId, first.id), eq(members.userId, userId)))
    .limit(1);
  return { organizationExists: true, roles: membership?.role ?? null };
}

export async function canCreateOrganization(userId: string): Promise<boolean> {
  const { organizationExists, roles } = await rolesInFirstOrganization(userId);
  return mayCreateOrganization({ mode: env().AUTH_SIGNUP, organizationExists, rolesInFirstOrganization: roles });
}

/** Whoever runs this install: see `adminsTheFirstOrganization`. Install-wide facts such as job failures are for them only. */
export async function isInstanceOperator(userId: string): Promise<boolean> {
  return adminsTheFirstOrganization((await rolesInFirstOrganization(userId)).roles);
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

/** The email a pending, unexpired invitation was sent to, or null. Lets an invited person reach sign-up on an invite-only instance. */
export async function pendingInvitationEmail(invitationId: string): Promise<string | null> {
  if (!/^[0-9a-f-]{36}$/i.test(invitationId)) return null;
  const [row] = await db
    .select({ email: invitations.email })
    .from(invitations)
    .where(and(eq(invitations.id, invitationId), eq(invitations.status, "pending"), gt(invitations.expiresAt, new Date())))
    .limit(1);
  return row?.email ?? null;
}
