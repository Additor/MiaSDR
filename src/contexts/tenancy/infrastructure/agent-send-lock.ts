import { sql } from "drizzle-orm";
import type { DbHandle } from "@/platform/db/client";

/**
 * The organization's agent-send lock (docs/database.md, "Lock modes"). A member change (a role change or a removal,
 * `drizzle-member-store.ts`) takes it exclusive before any row lock, so an agent action that starts after it answers
 * sees the new state. A policy change or a token revoke that writes the database must take it the same way.
 */
export const lockAgentSend = (tx: DbHandle, organizationId: string) =>
  tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`agent-send:${organizationId}`}, 0))`);
