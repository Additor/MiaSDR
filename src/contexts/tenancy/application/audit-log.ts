import { isOwnerOrAdmin } from "@/contexts/tenancy/domain/roles";
import { ForbiddenError, type Actor } from "@/shared/errors";

/** One organization-level audit row. */
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

/** Writes organization-level audit rows (`audit_log`). A failed write throws to the caller. Use cases take it as a port. */
export interface AuditSink {
  record(entry: AuditEntry): Promise<void>;
}

export interface AuditRow {
  id: string;
  action: string;
  actorName: string | null;
  entityType: string | null;
  meta: Record<string, unknown>;
  createdAt: Date;
}

/** Port. The organization's `audit_log`, newest first, with the actor's name as it is now. */
export interface AuditLogStore {
  list(organizationId: string, query: { area: string | null; limit: number; offset: number }): Promise<{ rows: AuditRow[]; total: number }>;
}

/** The first part of an action (`deal_stage` in `deal_stage.renamed`) names its area, which the page filters by. */
export const AUDIT_AREAS = ["organization", "integration", "mailbox", "suppression", "deal_stage", "deal", "company", "person", "enrollment", "linkedin", "ai_jobs", "search_batch"] as const;

export type AuditArea = (typeof AUDIT_AREAS)[number];

export function listAuditLog(store: AuditLogStore, actor: Actor, query: { area?: string | null; limit: number; offset: number }) {
  if (!isOwnerOrAdmin(actor.role)) throw new ForbiddenError("Only an owner or admin can read the audit log.");
  const area = query.area && (AUDIT_AREAS as readonly string[]).includes(query.area) ? query.area : null;
  return store.list(actor.organizationId, { area, limit: query.limit, offset: query.offset });
}
