import { sql } from "drizzle-orm";
import { publicConversationSql } from "@/platform/db/conversation-visibility";
import { excludedFromUnread } from "./inbox-sql";
import { db } from "@/platform/db/client";
import type { UnreadStore } from "../application/unread-count";

export const drizzleUnreadStore: UnreadStore = {
  async counts(organizationId) {
    const rows = (await db.execute(sql`
      select m.channel, count(*)::int as n
      from messages m
      join conversations c on c.id = m.conversation_id
      where m.organization_id = ${organizationId}
        and ${publicConversationSql("c")}
        and m.direction = 'inbound'
        and m.opened_at is null
        and not ${excludedFromUnread("m")}
      group by m.channel
    `)) as unknown as Array<{ channel: string; n: number }>;
    const by = (channel: string) => rows.find((r) => r.channel === channel)?.n ?? 0;
    return { total: rows.reduce((sum, r) => sum + r.n, 0), linkedin: by("linkedin"), email: by("email") };
  },
};
