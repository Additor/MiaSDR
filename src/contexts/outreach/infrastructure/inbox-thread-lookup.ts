import { and, desc, eq, inArray } from "drizzle-orm";
import { publicConversation } from "@/platform/db/conversation-visibility";
import { db } from "@/platform/db/client";
import { conversations, records } from "@/platform/db/schema";

/**
 * The Inbox conversation of each person on one channel, newest activity first, for the "Open reply" link of a lead row.
 * It reads through `publicConversation`, so a private thread of a personal campaign never gets a link here.
 */
export async function inboxConversationsOfPeople(organizationId: string, channel: "email" | "linkedin", personIds: string[]): Promise<Map<string, string>> {
  if (personIds.length === 0) return new Map();
  const rows = await db
    .select({ personId: records.personId, conversationId: conversations.id })
    .from(conversations)
    .innerJoin(records, eq(records.id, conversations.recordId))
    .where(and(eq(conversations.organizationId, organizationId), eq(conversations.channel, channel), publicConversation, inArray(records.personId, personIds)))
    .orderBy(desc(conversations.updatedAt));
  const byPerson = new Map<string, string>();
  for (const row of rows) if (!byPerson.has(row.personId)) byPerson.set(row.personId, row.conversationId);
  return byPerson;
}
