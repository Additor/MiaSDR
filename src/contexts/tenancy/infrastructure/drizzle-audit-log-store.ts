import { and, desc, eq, like, sql } from "drizzle-orm";
import { db } from "@/platform/db/client";
import { auditLog, users } from "@/platform/db/schema";
import type { AuditLogStore } from "../application/audit-log";

export const drizzleAuditLogStore: AuditLogStore = {
  async list(organizationId, { area, limit, offset }) {
    // Areas are a fixed list of word characters; `_` stays literal in LIKE.
    const where = and(eq(auditLog.organizationId, organizationId), area ? like(auditLog.action, `${area.replace(/_/g, "\\_")}.%`) : undefined);
    const [rows, [{ total }]] = await Promise.all([
      db
        .select({ id: auditLog.id, action: auditLog.action, actorName: users.name, entityType: auditLog.entityType, meta: auditLog.meta, createdAt: auditLog.createdAt })
        .from(auditLog)
        .leftJoin(users, eq(users.id, auditLog.actorUserId))
        .where(where)
        .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
        .limit(limit)
        .offset(offset),
      db.select({ total: sql<number>`count(*)::int` }).from(auditLog).where(where),
    ]);
    return { rows, total };
  },
};
