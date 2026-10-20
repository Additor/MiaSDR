import { recordAudit } from "@/platform/db/audit";
import type { LeadsAudit } from "../application/leads-audit";

/** The `LeadsAudit` port over `recordAudit`, in the caller's transaction. */
export const drizzleLeadsAudit: LeadsAudit = {
  record: (tx, entry) => recordAudit(tx, entry),
};
