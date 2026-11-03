import { and, asc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { db } from "@/platform/db/client";
import { campaigns, people, conversations } from "@/platform/db/schema";

/** Values for the lead filter dropdowns: campaigns that can be picked, the sources in use and the reply groups in use. */
export async function leadFilterOptions(organizationId: string): Promise<{
  campaigns: Array<{ id: string; name: string; channel: string }>;
  sources: string[];
  replyGroups: string[];
}> {
  const [campaignRows, sourceRows, replyGroupRows] = await Promise.all([
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
      .selectDistinct({ replyGroup: conversations.groupKey })
      .from(conversations)
      .where(and(eq(conversations.organizationId, organizationId), isNotNull(conversations.groupKey))),
  ]);
  return {
    campaigns: campaignRows,
    sources: sourceRows.map((r) => r.source).filter(Boolean).sort(),
    replyGroups: replyGroupRows.map((r) => r.replyGroup).filter((c): c is string => c !== null).sort(),
  };
}
