import "server-only";

import { APIError } from "better-auth/api";
import { headers } from "next/headers";
import { auth } from "@/contexts/identity/infrastructure/auth";
import { canCreateOrganization } from "@/contexts/identity/infrastructure/signup-facts";
import { ValidationError } from "@/shared/errors";
import type { ActiveOrganizationGateway, CreateOrganizationDeps } from "../application/create-organization";
import type { OrganizationDeps } from "../application/organization-settings";
import type { SwitchingDeps } from "../application/organization-switching";
import { isValidTimeZone } from "@/shared/time-zone";
import { drizzleMembershipStore, drizzleOrganizationCreationStore } from "./drizzle-organization-creation-store";
import { drizzleOrganizationStore } from "./drizzle-organization-store";
import { drizzleAuditLogStore } from "./drizzle-audit-log-store";
import type { AuditLogStore } from "../application/audit-log";

/** Better Auth writes sessions.active_organization_id and refreshes the session cookie. */
export const betterAuthActiveOrganization: ActiveOrganizationGateway = {
  async set(organizationId) {
    try {
      await auth().api.setActiveOrganization({ headers: await headers(), body: { organizationId } });
    } catch (error) {
      if (error instanceof APIError) throw new ValidationError(error.message || "Could not switch organization.");
      throw error;
    }
  },
};

export const createOrganizationDeps = (): CreateOrganizationDeps => ({
  store: drizzleOrganizationCreationStore,
  active: betterAuthActiveOrganization,
  mayCreate: canCreateOrganization,
});

export const switchingDeps = (): SwitchingDeps => ({
  memberships: drizzleMembershipStore,
  active: betterAuthActiveOrganization,
  mayCreate: canCreateOrganization,
});

/** Organization settings: the store plus the time zone check. */
export const organizationDeps = (): OrganizationDeps => ({ organizations: drizzleOrganizationStore, isValidTimeZone });

/** Settings, Audit log. */
export const auditLogStore: AuditLogStore = drizzleAuditLogStore;
