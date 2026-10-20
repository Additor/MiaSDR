import "server-only";

import { cache } from "react";
import { requireOrgContext } from "@/contexts/identity/infrastructure/session";
import { drizzleOrganizationStore } from "@/contexts/tenancy/infrastructure/drizzle-organization-store";

/**
 * The active organization's IANA time zone for server components ("UTC" when unset). React caches the result for the
 * request, so the app layout and every page below it share one lookup. Client components use `useOrgTimeZone` from
 * "@/components/shell/time" instead.
 */
export const getOrgTimeZone = cache(async (): Promise<string> => {
  const { organization } = await requireOrgContext();
  return (await drizzleOrganizationStore.get(organization.id))?.timeZone ?? "UTC";
});
