import { sql } from "drizzle-orm";
import type { DbHandle } from "@/platform/db/client";
import { channelSettings } from "@/platform/db/schema";

/**
 * The one writer of `channel_settings`, the organization's settings rows per channel (`general`, `email`, `linkedin`).
 * Tenancy declares the table; the screens of each context save their own keys through this merge, so keys another screen
 * owns survive.
 */
export async function mergeChannelSettings(handle: DbHandle, organizationId: string, channel: string, patch: Record<string, unknown>, userId: string | null): Promise<void> {
  await handle
    .insert(channelSettings)
    .values({ organizationId, channel, values: patch, updatedBy: userId })
    .onConflictDoUpdate({
      target: [channelSettings.organizationId, channelSettings.channel],
      set: { values: sql`${channelSettings.values} || ${JSON.stringify(patch)}::jsonb`, updatedBy: userId, updatedAt: new Date() },
    });
}
