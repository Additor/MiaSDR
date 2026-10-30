import { and, asc, eq, gt, isNull } from "drizzle-orm";
import { db } from "@/platform/db/client";
import { invitations, mcpTokens, members, users } from "@/platform/db/schema";
import { clearActiveOrganizationTx } from "@/contexts/identity/infrastructure/user-accounts";
import type { MemberStore } from "../application/member-management";
import { lockAgentSend } from "./agent-send-lock";

const invitationColumns = {
  id: invitations.id,
  email: invitations.email,
  role: invitations.role,
  status: invitations.status,
  expiresAt: invitations.expiresAt,
  createdAt: invitations.createdAt,
};

const toInvitation = <T extends { role: string | null }>(row: T) => ({ ...row, role: row.role ?? "member" });

export const drizzleMemberStore: MemberStore = {
  async list(organizationId) {
    return db
      .select({ id: members.id, userId: members.userId, role: members.role, name: users.name, email: users.email, joinedAt: members.createdAt })
      .from(members)
      .innerJoin(users, eq(users.id, members.userId))
      .where(eq(members.organizationId, organizationId))
      .orderBy(asc(members.createdAt), asc(users.email));
  },

  async hasMemberWithEmail(organizationId, email) {
    const [row] = await db
      .select({ id: members.id })
      .from(members)
      .innerJoin(users, eq(users.id, members.userId))
      .where(and(eq(members.organizationId, organizationId), eq(users.email, email)))
      .limit(1);
    return Boolean(row);
  },

  async listPendingInvitations(organizationId) {
    const rows = await db
      .select(invitationColumns)
      .from(invitations)
      .where(and(eq(invitations.organizationId, organizationId), eq(invitations.status, "pending"), gt(invitations.expiresAt, new Date())))
      .orderBy(asc(invitations.createdAt));
    return rows.map(toInvitation);
  },

  async getInvitation(organizationId, id) {
    const [row] = await db
      .select(invitationColumns)
      .from(invitations)
      .where(and(eq(invitations.organizationId, organizationId), eq(invitations.id, id)));
    return row ? toInvitation(row) : null;
  },

  async cancelInvitation(organizationId, id) {
    await db
      .update(invitations)
      .set({ status: "canceled" })
      .where(and(eq(invitations.organizationId, organizationId), eq(invitations.id, id), eq(invitations.status, "pending")));
  },

  transaction(organizationId, run) {
    return db.transaction(async (tx) => {
      // Before the member rows: a role change or a removal then lands between agent actions, never inside one.
      await lockAgentSend(tx, organizationId);
      return run({
        async members() {
          return tx
            .select({ id: members.id, userId: members.userId, role: members.role })
            .from(members)
            .where(eq(members.organizationId, organizationId))
            .for("update");
        },
        async setRole(memberId, role) {
          await tx.update(members).set({ role }).where(and(eq(members.organizationId, organizationId), eq(members.id, memberId)));
        },
        async remove(memberId) {
          const [row] = await tx
            .delete(members)
            .where(and(eq(members.organizationId, organizationId), eq(members.id, memberId)))
            .returning({ userId: members.userId });
          if (!row) return;
          await clearActiveOrganizationTx(tx, row.userId, organizationId);
          // Revoked, not deleted: a later invitation makes a new member row, and the old tokens stay dead.
          await tx
            .update(mcpTokens)
            .set({ revokedAt: new Date() })
            .where(and(eq(mcpTokens.organizationId, organizationId), eq(mcpTokens.userId, row.userId), isNull(mcpTokens.revokedAt)));
        },
      });
    });
  },
};
