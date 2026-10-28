import { and, eq } from "drizzle-orm";
import { db } from "@/platform/db/client";
import { channelSettings } from "@/platform/db/schema";
import { mergeChannelSettings } from "@/contexts/tenancy/infrastructure/channel-settings";
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
    await mergeChannelSettings(db, organizationId, channel, patch, userId);
  },
};
