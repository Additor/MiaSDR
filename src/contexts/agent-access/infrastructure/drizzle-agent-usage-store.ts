import { and, eq, sql } from "drizzle-orm";
import { db } from "@/platform/db/client";
import { mcpAgentUsage } from "@/platform/db/schema";
import type { AgentUsageStore } from "../application/mcp-agent-usage";
import { agentUsageLimit } from "../domain/mcp-agent-usage";
import { readAgentActionGate } from "./mcp-policy-reader";

export const drizzleAgentUsageStore: AgentUsageStore = {
  reserve(reservation, now) {
    const { organizationId, tokenId, day, kind, amount } = reservation;
    return db.transaction(async (tx) => {
      const limit = agentUsageLimit(kind, await readAgentActionGate(tx, { organizationId, tokenId, now }));
      if (typeof limit === "string") return limit;
      if (amount > limit) return "over_limit";
      // Two reservations at the boundary hold the lock shared. The row update takes them one at a time, and the
      // condition reads the amount the first one wrote.
      const written = await tx
        .insert(mcpAgentUsage)
        .values({ organizationId, day, kind, amount })
        .onConflictDoUpdate({
          target: [mcpAgentUsage.organizationId, mcpAgentUsage.day, mcpAgentUsage.kind],
          set: { amount: sql`${mcpAgentUsage.amount} + excluded.amount` },
          setWhere: sql`${mcpAgentUsage.amount} + excluded.amount <= ${limit}`,
        })
        .returning({ amount: mcpAgentUsage.amount });
      return written.length > 0 ? null : "over_limit";
    });
  },

  async release({ organizationId, day, kind, amount }) {
    await db
      .update(mcpAgentUsage)
      .set({ amount: sql`greatest(${mcpAgentUsage.amount} - ${amount}, 0)` })
      .where(and(eq(mcpAgentUsage.organizationId, organizationId), eq(mcpAgentUsage.day, day), eq(mcpAgentUsage.kind, kind)));
  },
};
