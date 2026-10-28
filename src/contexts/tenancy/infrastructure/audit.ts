import { db, type DbHandle } from "@/platform/db/client";
import { auditLog } from "@/platform/db/schema";
import type { AuditEntry, AuditSink } from "../application/audit-log";

/**
 * The one writer of `audit_log`, which tenancy declares. Other contexts record their organization-level changes through
 * it, on the pool or inside their own transaction so the row commits with the change.
 */
export async function recordAudit(handle: DbHandle, entry: AuditEntry): Promise<void> {
  await handle.insert(auditLog).values({
    organizationId: entry.organizationId,
    actorUserId: entry.actorUserId,
    action: entry.action,
    entityType: entry.entityType ?? null,
    entityId: entry.entityId ?? null,
    meta: entry.meta ?? {},
  });
}

/** The audit sink on the pool. */
export const auditSink: AuditSink = { record: (entry) => recordAudit(db, entry) };
