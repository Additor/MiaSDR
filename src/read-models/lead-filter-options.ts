import { and, asc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { db } from "@/platform/db/client";
import { campaigns, people, records } from "@/platform/db/schema";

/** Values for the lead filter dropdowns: campaigns that can be picked, the sources in use and the CRM categories in use. */
export async function leadFilterOptions(organizationId: string): Promise<{
  campaigns: Array<{ id: string; name: string; channel: string }>;
  sources: string[];
  categories: string[];
}> {
  const [campaignRows, sourceRows, categoryRows] = await Promise.all([
    db
      .select({ id: campaigns.id, name: campaigns.name, channel: campaigns.channel })
      .from(campaigns)
      .where(and(eq(campaigns.organizationId, organizationId), isNull(campaigns.archivedAt)))
      .orderBy(asc(campaigns.name), asc(campaigns.id)),
    db
      .selectDistinct({ source: sql<string>`split_part(${people.source}, ':', 1)` })
      .from(people)
      .where(and(eq(people.organizationId, organizationId), isNotNull(people.source))),
    db
      .selectDistinct({ category: records.groupKey })
      .from(records)
      .where(and(eq(records.organizationId, organizationId), isNotNull(records.groupKey))),
  ]);
  return {
    campaigns: campaignRows,
    sources: sourceRows.map((r) => r.source).filter(Boolean).sort(),
    categories: categoryRows.map((r) => r.category).filter((c): c is string => c !== null).sort(),
  };
}
