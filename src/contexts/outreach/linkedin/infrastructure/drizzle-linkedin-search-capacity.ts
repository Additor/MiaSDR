import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/platform/db/client";
import { channelSettings, linkedinAccounts } from "@/platform/db/schema";
import type { LinkedInSearchCapacityStore } from "../application/linkedin-search-ports";
import { linkedinRules } from "../domain/linkedin";

export const drizzleLinkedInSearchCapacityStore: LinkedInSearchCapacityStore = {
  async usage(organizationId, accountIds) {
    const [settings] = await db
      .select({ values: channelSettings.values })
      .from(channelSettings)
      .where(and(eq(channelSettings.organizationId, organizationId), eq(channelSettings.channel, "linkedin")));
    const rows = await db
      .select({
        id: linkedinAccounts.id,
        name: sql<string>`coalesce(${linkedinAccounts.name}, ${linkedinAccounts.username}, ${linkedinAccounts.id}::text)`,
        usedToday: linkedinAccounts.searchLeadsToday,
        usedDay: linkedinAccounts.searchDay,
        limitReachedUntil: linkedinAccounts.limitReachedUntil,
      })
      .from(linkedinAccounts)
      .where(and(eq(linkedinAccounts.organizationId, organizationId), eq(linkedinAccounts.status, "connected"), accountIds.length > 0 ? inArray(linkedinAccounts.id, accountIds) : undefined))
      .orderBy(asc(linkedinAccounts.createdAt));
    return { limit: linkedinRules(settings?.values).searchLeadsPerDay, accounts: rows };
  },
};
