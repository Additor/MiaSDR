import { and, eq, sql } from "drizzle-orm";
import { db } from "@/platform/db/client";
import { channelSettings, organizations } from "@/platform/db/schema";
import type { ChannelSettingsStore } from "../email/application/email-rules";

export const drizzleChannelSettingsStore: ChannelSettingsStore = {
  async get(organizationId, channel) {
    const [row] = await db
      .select({ values: channelSettings.values })
      .from(channelSettings)
      .where(and(eq(channelSettings.organizationId, organizationId), eq(channelSettings.channel, channel)));
    return row?.values ?? null;
  },

  async merge(organizationId, channel, patch, userId) {
    // `organizations.timezone` mirrors the `general` zone so both readers agree.
    if (channel === "general" && typeof patch.timeZone === "string") {
      await db.update(organizations).set({ timezone: patch.timeZone }).where(eq(organizations.id, organizationId));
    }
    await db
      .insert(channelSettings)
      .values({ organizationId, channel, values: patch, updatedBy: userId })
      .onConflictDoUpdate({
        target: [channelSettings.organizationId, channelSettings.channel],
        set: { values: sql`${channelSettings.values} || ${JSON.stringify(patch)}::jsonb`, updatedBy: userId, updatedAt: new Date() },
      });
  },
};
