import type { DbHandle } from "./client";
import { auditLog } from "./schema";

export interface AuditEntry {
  organizationId: string;
  actorUserId: string | null;
  /** Dotted verb such as `integration.saved`. */
  action: string;
  entityType?: string;
  entityId?: string;
  /** Facts about the change. Never a secret, a token or a prefix of one. */
  meta?: Record<string, unknown>;
}

/** Writes one audit row on the pool or inside the caller's transaction, so the row commits with the change. */
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
