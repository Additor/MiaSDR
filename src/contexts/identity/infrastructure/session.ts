import "server-only";

import { and, eq } from "drizzle-orm";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { db } from "@/platform/db/client";
import { members, organizations } from "@/platform/db/schema";
import { auth } from "./auth";
import { initialOrganizationId } from "./signup-facts";

export interface OrgContext {
  user: { id: string; name: string; email: string; image: string | null };
  organization: { id: string; name: string; slug: string };
  /** Stored role string; use tenancy/domain/roles to interpret it. */
  role: string;
}

async function membershipIn(userId: string, organizationId: string) {
  const [row] = await db
    .select({
      role: members.role,
      orgId: organizations.id,
      orgName: organizations.name,
      orgSlug: organizations.slug,
    })
    .from(members)
    .innerJoin(organizations, eq(organizations.id, members.organizationId))
    .where(and(eq(members.userId, userId), eq(members.organizationId, organizationId)))
    .limit(1);
  return row;
}

type Resolution = { ok: true; ctx: OrgContext } | { ok: false; reason: "unauthenticated" | "no-organization" };

/**
 * Validates the session and the user's membership in the active organization.
 * Reads request headers, so call it inside a <Suspense> boundary. The role is
 * re-read from the database on every call: removing a member takes effect
 * immediately even while their cookie cache is still warm.
 */
export const resolveOrgContext = cache(async (): Promise<Resolution> => {
  const session = await auth().api.getSession({ headers: await headers() });
  if (!session) return { ok: false, reason: "unauthenticated" };

  // The cookie cache can serve an active organization the user no longer belongs to (removed within the last
  // two minutes). Fall back to the oldest membership instead of failing.
  const activeId = session.session.activeOrganizationId;
  let row = activeId ? await membershipIn(session.user.id, activeId) : undefined;
  if (!row) {
    const fallbackId = await initialOrganizationId(session.user.id);
    if (fallbackId && fallbackId !== activeId) row = await membershipIn(session.user.id, fallbackId);
  }
  if (!row) return { ok: false, reason: "no-organization" };

  return {
    ok: true,
    ctx: {
      user: {
        id: session.user.id,
        name: session.user.name,
        email: session.user.email,
        image: session.user.image ?? null,
      },
      organization: { id: row.orgId, name: row.orgName, slug: row.orgSlug },
      role: row.role,
    },
  };
});

/** For pages: redirects instead of returning a failure. */
export async function requireOrgContext(): Promise<OrgContext> {
  const resolved = await resolveOrgContext();
  if (resolved.ok) return resolved.ctx;
  if (resolved.reason === "no-organization") redirect("/sign-in?error=no-organization");
  // An expired session keeps the visitor's place: sign-in returns them to this page.
  const path = (await headers()).get("x-miasdr-path");
  redirect(path && path.startsWith("/") && !path.startsWith("//") ? `/sign-in?next=${encodeURIComponent(path)}` : "/sign-in");
}

/** For route handlers: null means answer 401 (the caller owns the response). */
export async function apiOrgContext(): Promise<OrgContext | null> {
  const resolved = await resolveOrgContext();
  return resolved.ok ? resolved.ctx : null;
}

export interface SessionUser {
  userId: string;
  /** The active organization stored on the session. May be stale or null: see resolveOrgContext. */
  activeOrganizationId: string | null;
}

/** For route handlers that need a signed-in user but no organization. Null means answer 401. */
export async function apiUser(): Promise<SessionUser | null> {
  const session = await auth().api.getSession({ headers: await headers() });
  return session ? { userId: session.user.id, activeOrganizationId: session.session.activeOrganizationId ?? null } : null;
}
