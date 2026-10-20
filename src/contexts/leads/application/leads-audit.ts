import type { DbHandle } from "@/platform/db/client";

/*
 * The audit rows of the leads use cases ("Contacts and Companies CRUD" in docs/decisions.md). `audit_log` is append-only and
 * admin-only. A row commits with the change, inside the caller's transaction. `company.merged` holds the dropped company values,
 * which can hold personal data; `person.deleted` holds ids and counts and never a name or an address.
 */

export type LeadsAuditAction = "company.created" | "company.merged" | "company.deleted" | "person.deleted";

export interface LeadsAuditEntry {
  organizationId: string;
  actorUserId: string | null;
  action: LeadsAuditAction;
  entityType: "company" | "person";
  entityId: string;
  meta: Record<string, unknown>;
}

export interface LeadsAudit {
  record(tx: DbHandle, entry: LeadsAuditEntry): Promise<void>;
}
