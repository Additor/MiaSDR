import { drizzleOrganizationStore } from "@/contexts/tenancy/infrastructure/drizzle-organization-store";

/** The organization's IANA time zone ("UTC" when the organization is gone). The Inbox and the work queue read their date filters in it. */
export async function organizationTimeZone(organizationId: string): Promise<string> {
  return (await drizzleOrganizationStore.get(organizationId))?.timeZone ?? "UTC";
}
