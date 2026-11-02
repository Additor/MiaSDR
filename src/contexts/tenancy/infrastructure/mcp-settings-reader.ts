import { and, eq } from "drizzle-orm";
import type { DbHandle } from "@/platform/db/client";
import { channelSettings } from "@/platform/db/schema";
import { MCP_SETTINGS_CHANNEL, readMcpSettings, type McpSettings } from "../domain/mcp-settings";

/** The organization's MCP settings through `handle`: `db`, or a transaction that holds the agent-send lock. */
export async function mcpSettingsIn(handle: DbHandle, organizationId: string): Promise<McpSettings> {
  const [row] = await handle
    .select({ values: channelSettings.values })
    .from(channelSettings)
    .where(and(eq(channelSettings.organizationId, organizationId), eq(channelSettings.channel, MCP_SETTINGS_CHANNEL)));
  return readMcpSettings(row?.values);
}
