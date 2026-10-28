import { recordAudit } from "@/contexts/tenancy/infrastructure/audit";
import type { LeadsAudit } from "../application/leads-audit";

/** The `LeadsAudit` port over `recordAudit`, in the caller's transaction. */
export const drizzleLeadsAudit: LeadsAudit = {
  record: (tx, entry) => recordAudit(tx, entry),
};
