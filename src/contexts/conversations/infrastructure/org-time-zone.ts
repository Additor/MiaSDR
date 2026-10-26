import { organizationTimeZone as readZone } from "@/contexts/tenancy/infrastructure/drizzle-organization-store";

/** The organization's IANA time zone ("UTC" when the organization is gone). The Inbox and the work queue read their date filters in it. */
export const organizationTimeZone = (organizationId: string): Promise<string> => readZone(organizationId);
