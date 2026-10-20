import { and, count, eq, inArray, sql, type SQL } from "drizzle-orm";
import { leadSearchCondition } from "@/contexts/leads/infrastructure/queries";
import { db } from "@/platform/db/client";
import { campaignEnrollments, sends } from "@/platform/db/schema";
import { countsByTab, statusesForTab, type EnrollmentListQuery, type TabCounts } from "../domain/enrollment-list";

/** Rows of one campaign in one organization. Counts use this alone, so they ignore the tab, the search and the page. */
export const campaignScope = (organizationId: string, campaignId: string): SQL =>
  and(eq(campaignEnrollments.organizationId, organizationId), eq(campaignEnrollments.campaignId, campaignId)) as SQL;

/**
 * Scope plus status filter and search. With `campaignStatus` the filter selects the statuses that read as its state in
 * that campaign (`statusesForTab`). The query must join `people` and `companies` (the search reads both).
 * The search escapes LIKE wildcards (`leadSearchCondition`).
 */
export const filteredScope = (organizationId: string, campaignId: string, query: Pick<EnrollmentListQuery, "tab" | "search" | "campaignStatus">): SQL =>
  and(campaignScope(organizationId, campaignId), inArray(campaignEnrollments.status, [...statusesForTab(query.tab, query.campaignStatus)]), leadSearchCondition(query.search)) as SQL;

/** Filter counts over the whole campaign, whatever filter is active. `campaignStatus` places each status under one filter (`countsByTab`). */
export async function tabCounts(organizationId: string, campaignId: string, campaignStatus?: string): Promise<TabCounts> {
  const rows = await db
    .select({ status: campaignEnrollments.status, n: count() })
    .from(campaignEnrollments)
    .where(campaignScope(organizationId, campaignId))
    .groupBy(campaignEnrollments.status);
  return countsByTab(rows, campaignStatus);
}

/** Sends of the campaign that went out (email messages, LinkedIn invitations and messages). Like the tab counts, it ignores the active filter. */
export async function sentCount(organizationId: string, campaignId: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(sends)
    .innerJoin(campaignEnrollments, eq(campaignEnrollments.id, sends.enrollmentId))
    .where(and(eq(sends.organizationId, organizationId), eq(sends.status, "sent"), eq(campaignEnrollments.organizationId, organizationId), eq(campaignEnrollments.campaignId, campaignId)));
  return row?.n ?? 0;
}
