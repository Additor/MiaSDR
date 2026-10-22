import { isOwnerOrAdmin } from "@/contexts/tenancy/domain/roles";
import { ForbiddenError, type Actor } from "@/shared/errors";

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
export const AUDIT_AREAS = ["organization", "integration", "suppression", "deal_stage", "deal", "company", "person", "enrollment", "linkedin", "ai_jobs", "search_batch"] as const;

export function listAuditLog(store: AuditLogStore, actor: Actor, query: { area?: string | null; limit: number; offset: number }) {
  if (!isOwnerOrAdmin(actor.role)) throw new ForbiddenError("Only an owner or admin can read the audit log.");
  const area = query.area && (AUDIT_AREAS as readonly string[]).includes(query.area) ? query.area : null;
  return store.list(actor.organizationId, { area, limit: query.limit, offset: query.offset });
}
