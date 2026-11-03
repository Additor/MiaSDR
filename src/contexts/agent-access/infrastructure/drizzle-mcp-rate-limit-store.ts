import { sql } from "drizzle-orm";
import { db } from "@/platform/db/client";
import { mcpRateLimits } from "@/platform/db/schema";
import type { McpRateLimitStore } from "../application/mcp-rate-limit";

export const drizzleMcpRateLimitStore: McpRateLimitStore = {
  async hit({ organizationId, tokenId, bucket, windowStart }) {
    // One statement, so two requests that race both count: the second waits on the row and reads the first's count.
    const [row] = await db
      .insert(mcpRateLimits)
      .values({ organizationId, tokenId, bucket, windowStart, count: 1 })
      .onConflictDoUpdate({
        target: [mcpRateLimits.organizationId, mcpRateLimits.tokenId, mcpRateLimits.bucket],
        set: {
          count: sql`case when ${mcpRateLimits.windowStart} = excluded.window_start then ${mcpRateLimits.count} + 1 else 1 end`,
          windowStart: sql`excluded.window_start`,
        },
      })
      .returning({ count: mcpRateLimits.count });
    return row.count;
  },
};
