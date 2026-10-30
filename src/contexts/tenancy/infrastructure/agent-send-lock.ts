import { sql } from "drizzle-orm";
import type { DbHandle } from "@/platform/db/client";

/**
 * The organization's agent-send lock (docs/database.md, "Lock modes"). A policy change, a token revoke and a member
 * removal take it exclusive before any row lock, so an agent action that starts after they answer sees the new state.
 */
export const lockAgentSend = (tx: DbHandle, organizationId: string) =>
  tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`agent-send:${organizationId}`}, 0))`);
