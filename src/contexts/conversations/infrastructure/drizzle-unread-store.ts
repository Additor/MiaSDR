import { sql } from "drizzle-orm";
import { unreadMessageSql } from "./inbox-sql";
import { db } from "@/platform/db/client";
import type { UnreadStore } from "../application/unread-count";

export const drizzleUnreadStore: UnreadStore = {
  async counts(organizationId) {
    const rows = (await db.execute(sql`
      select m.channel, count(*)::int as n
      from messages m
      where m.organization_id = ${organizationId}
        and ${unreadMessageSql("m")}
      group by m.channel
    `)) as unknown as Array<{ channel: string; n: number }>;
    const by = (channel: string) => rows.find((r) => r.channel === channel)?.n ?? 0;
    return { total: rows.reduce((sum, r) => sum + r.n, 0), linkedin: by("linkedin"), email: by("email") };
  },
};
