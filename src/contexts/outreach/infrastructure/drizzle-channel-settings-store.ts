import { and, eq } from "drizzle-orm";
import { db, type DbHandle } from "@/platform/db/client";
import { channelSettings } from "@/platform/db/schema";
import { mergeChannelSettings } from "@/contexts/tenancy/infrastructure/channel-settings";
import type { ChannelSettingsStore } from "../email/application/email-rules";
import { senderPostalAddress } from "../domain/send-policy";

/** The address a campaign's footer carries. With `tx`, an agent's launch reads it inside the transaction that holds the campaign. */
export async function readSenderPostalAddress(organizationId: string, tx: DbHandle = db): Promise<string | null> {
  const [row] = await tx
    .select({ values: channelSettings.values })
    .from(channelSettings)
    .where(and(eq(channelSettings.organizationId, organizationId), eq(channelSettings.channel, "email")));
  return senderPostalAddress(row?.values);
}

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
