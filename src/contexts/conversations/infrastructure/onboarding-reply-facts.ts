import { and, count, eq, isNull, notLike, or, sql } from "drizzle-orm";
import { db } from "@/platform/db/client";
import { messages } from "@/platform/db/schema";
import { env } from "@/shared/env";

/**
 * What the setup guide's reply step reads: replies received on any channel. An auto-reply is not a person answering, and
 * mail the fake provider delivered counts only on an install that runs it.
 */
export async function onboardingReplyFacts(organizationId: string, countDemoReplies = env().MAILBOX_PROVIDER === "fake"): Promise<{ replies: number }> {
  const [row] = await db
    .select({ n: count() })
    .from(messages)
    .where(
      and(
        eq(messages.organizationId, organizationId),
        eq(messages.direction, "inbound"),
        sql`${messages.raw}->>'autoReply' is distinct from 'true'`,
        countDemoReplies ? undefined : or(isNull(messages.providerMessageId), notLike(messages.providerMessageId, "fake-%")),
      ),
    );
  return { replies: row?.n ?? 0 };
}
