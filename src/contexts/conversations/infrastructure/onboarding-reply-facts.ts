import { and, count, eq, sql } from "drizzle-orm";
import { db } from "@/platform/db/client";
import { drafts, sendAttempts } from "@/platform/db/schema";
import { visibleDraftSql } from "@/platform/db/conversation-visibility";

/**
 * What the onboarding checklist's "Approve your first message" step reads: drafts waiting in the Inbox, and replies a
 * person sent. An agent's send (`origin = 'agent'`) does not count, so the step still asks a person to send one.
 */
export async function onboardingReplyFacts(organizationId: string): Promise<{ draftsAwaiting: number; messagesApproved: number }> {
  const [[awaiting], [approved]] = await Promise.all([
    // The awaiting count must match what the Inbox shows, so private conversations stay out.
    db
      .select({ n: count() })
      .from(drafts)
      .where(and(eq(drafts.organizationId, organizationId), eq(drafts.status, "awaiting_review"), visibleDraftSql("drafts"))),
    db
      .select({ n: count() })
      .from(drafts)
      .where(
        and(
          eq(drafts.organizationId, organizationId),
          eq(drafts.status, "sent"),
          visibleDraftSql("drafts"),
          sql`exists (select 1 from ${sendAttempts} where ${sendAttempts.draftId} = ${drafts.id} and ${sendAttempts.origin} = 'person' and ${sendAttempts.status} in ('sent', 'reconciled'))`,
        ),
      ),
  ]);
  return { draftsAwaiting: awaiting?.n ?? 0, messagesApproved: approved?.n ?? 0 };
}
