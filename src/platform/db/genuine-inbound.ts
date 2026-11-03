import { sql, type SQL } from "drizzle-orm";

/**
 * True for a message `alias` that a person wrote to us: inbound, and not flagged as an auto-reply or an unverified bounce
 * when it was filed. An out-of-office is history, so it makes nobody Replied. Every "did they reply?" reads this.
 */
export const genuineInboundSql = (alias: string): SQL => sql.raw(`(${alias}.direction = 'inbound' and coalesce(${alias}.raw->>'autoReply', 'false') <> 'true')`);
