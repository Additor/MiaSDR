import { eq } from "drizzle-orm";
import { db } from "@/platform/db/client";
import { invitations, organizations, users } from "@/platform/db/schema";
import type { InvitationReader } from "../application/invitation-view";

export const drizzleInvitationReader: InvitationReader = {
  async find(id) {
    const [row] = await db
      .select({
        id: invitations.id,
        email: invitations.email,
        role: invitations.role,
        status: invitations.status,
        expiresAt: invitations.expiresAt,
        organizationName: organizations.name,
        inviterName: users.name,
      })
      .from(invitations)
      .innerJoin(organizations, eq(organizations.id, invitations.organizationId))
      .innerJoin(users, eq(users.id, invitations.inviterId))
      .where(eq(invitations.id, id));
    return row ? { ...row, role: row.role ?? "member" } : null;
  },
};
