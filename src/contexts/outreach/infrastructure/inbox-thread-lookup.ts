import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "@/platform/db/client";
import { threads, conversations } from "@/platform/db/schema";

/**
 * The Inbox conversation of each person on one channel, newest activity first, for the "Open reply" link of a lead row.
 */
export async function inboxThreadsOfPeople(organizationId: string, channel: "email" | "linkedin", personIds: string[]): Promise<Map<string, string>> {
  if (personIds.length === 0) return new Map();
  const rows = await db
    .select({ personId: conversations.personId, threadId: threads.id })
    .from(threads)
    .innerJoin(conversations, eq(conversations.id, threads.conversationId))
    .where(and(eq(threads.organizationId, organizationId), eq(threads.channel, channel), inArray(conversations.personId, personIds)))
    .orderBy(desc(threads.updatedAt));
  const byPerson = new Map<string, string>();
  for (const row of rows) if (!byPerson.has(row.personId)) byPerson.set(row.personId, row.threadId);
  return byPerson;
}
