import { and, eq, sql, type SQL } from "drizzle-orm";
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

/** Sets one key of an existing row to the jsonb that `value` computes, for a value that SQL has to work out. A missing row stays missing. */
export async function setChannelSettingTo(handle: DbHandle, organizationId: string, channel: string, key: string, value: SQL): Promise<void> {
  await handle
    .update(channelSettings)
    .set({ values: sql`jsonb_set(${channelSettings.values}, ${`{${key}}`}::text[], ${value})` })
    .where(and(eq(channelSettings.organizationId, organizationId), eq(channelSettings.channel, channel)));
}
