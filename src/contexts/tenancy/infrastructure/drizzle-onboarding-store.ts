import { and, count, eq, sql } from "drizzle-orm";
import { db } from "@/platform/db/client";
// Other contexts' tables come through the shared schema barrel, read only, inside this adapter (same rule as the lead repository).
import { campaigns, channelSettings, linkedinAccounts, mailboxes, people } from "@/platform/db/schema";
import type { OnboardingStore } from "../application/onboarding";

/** Dismissal lives in the existing `channel_settings` table under its own channel, so no schema change is needed. */
const ONBOARDING_CHANNEL = "onboarding";

export const drizzleOnboardingStore: OnboardingStore = {
  async facts(organizationId) {
    const [general, mailboxRows, linkedin, leads, campaignRows] = await Promise.all([
      db
        .select({ zone: sql<string | null>`${channelSettings.values}->>'timeZone'` })
        .from(channelSettings)
        .where(and(eq(channelSettings.organizationId, organizationId), eq(channelSettings.channel, "general"))),
      db
        .select({ status: mailboxes.status, n: count() })
        .from(mailboxes)
        .where(eq(mailboxes.organizationId, organizationId))
        .groupBy(mailboxes.status),
      db
        .select({ n: count() })
        .from(linkedinAccounts)
        .where(and(eq(linkedinAccounts.organizationId, organizationId), eq(linkedinAccounts.status, "connected"))),
      // Leads only: a contact lives in the CRM and does not count toward "import your first leads".
      db.select({ n: count() }).from(people).where(and(eq(people.organizationId, organizationId), eq(people.lifecycle, "lead"))),
      db
        .select({ status: campaigns.status, n: count() })
        .from(campaigns)
        .where(eq(campaigns.organizationId, organizationId))
        .groupBy(campaigns.status),
    ]);
    const sum = (rows: Array<{ n: number }>) => rows.reduce((total, r) => total + r.n, 0);
    return {
      timeZoneSaved: Boolean(general[0]?.zone),
      connectedMailboxes: sum(mailboxRows.filter((r) => r.status === "connected")),
      totalMailboxes: sum(mailboxRows),
      connectedLinkedInAccounts: linkedin[0]?.n ?? 0,
      leads: leads[0]?.n ?? 0,
      campaigns: sum(campaignRows),
      activeCampaigns: sum(campaignRows.filter((r) => r.status === "active")),
    };
  },

  async isDismissed(organizationId) {
    const [row] = await db
      .select({ at: sql<string | null>`${channelSettings.values}->>'dismissedAt'` })
      .from(channelSettings)
      .where(and(eq(channelSettings.organizationId, organizationId), eq(channelSettings.channel, ONBOARDING_CHANNEL)));
    return Boolean(row?.at);
  },

  async dismiss(organizationId, userId) {
    const values = { dismissedAt: new Date().toISOString(), dismissedBy: userId };
    await db
      .insert(channelSettings)
      .values({ organizationId, channel: ONBOARDING_CHANNEL, values, updatedBy: userId })
      .onConflictDoUpdate({
        target: [channelSettings.organizationId, channelSettings.channel],
        set: { values, updatedBy: userId, updatedAt: new Date() },
      });
  },
};
