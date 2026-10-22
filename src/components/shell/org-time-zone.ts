import "server-only";

import { cache } from "react";
import { requireOrgContext } from "@/contexts/identity/infrastructure/session";
import { readSendPause, type SendPause } from "@/contexts/outreach/domain/send-pause";
import { emailRulesDeps } from "@/contexts/outreach/infrastructure/composition";
import { drizzleOrganizationStore } from "@/contexts/tenancy/infrastructure/drizzle-organization-store";
import { canonicalTimeZone, isValidTimeZone } from "@/shared/time-zone";

/** The organization's `general` settings row, read once per request for the zone and the sending pause. */
const orgGeneral = cache(async (organizationId: string) => emailRulesDeps().settings.get(organizationId, "general"));

/**
 * The active organization's IANA time zone for server components ("UTC" when unset). React caches the result for the
 * request, so the app layout and every page below it share one lookup. Client components use `useOrgTimeZone` from
 * "@/components/shell/time" instead. The `general` row wins, as the send engine reads it; the organization row is read
 * only when that row holds no valid zone.
 */
export const getOrgTimeZone = cache(async (): Promise<string> => {
  const { organization } = await requireOrgContext();
  const zone = (await orgGeneral(organization.id))?.timeZone;
  if (typeof zone === "string" && isValidTimeZone(zone)) return canonicalTimeZone(zone) ?? zone;
  return (await drizzleOrganizationStore.get(organization.id))?.timeZone ?? "UTC";
});

/** The organization's own sending pause for the shell's banner, from the same cached row as the zone. Null while sending runs. */
export const getOrgSendPause = cache(async (): Promise<SendPause | null> => {
  const { organization } = await requireOrgContext();
  return readSendPause(await orgGeneral(organization.id));
});
