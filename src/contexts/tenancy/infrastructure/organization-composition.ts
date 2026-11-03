import "server-only";

import type { OrganizationDeps } from "../application/organization-settings";
import { isValidTimeZone } from "@/shared/time-zone";
import { drizzleOrganizationStore } from "./drizzle-organization-store";
import { drizzleAuditLogStore } from "./drizzle-audit-log-store";
import type { AuditLogStore } from "../application/audit-log";

/** Organization settings: the store plus the time zone check. */
export const organizationDeps = (): OrganizationDeps => ({ organizations: drizzleOrganizationStore, isValidTimeZone });

/** Settings, Audit log. */
export const auditLogStore: AuditLogStore = drizzleAuditLogStore;
