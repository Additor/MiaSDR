import { and, eq, inArray, sql } from "drizzle-orm";
import { db, type DbHandle } from "@/platform/db/client";
import { drafts, linkedinAccounts, sendAttempts, sends } from "@/platform/db/schema";
import { SEND_COUNTED } from "../../domain/send-status";

/*
 * What a provider answer does to a LinkedIn account. Outreach owns `linkedin_accounts`; its campaign sends and
 * conversations' replies both hit the same limits and the same disconnects, and both record them here. Both count
 * against the same daily message cap, so the count is here too.
 */

/** Messages one account sent since the start of the UTC day: sequence messages (step 2 and later) and replies. */
export async function countMessagesToday(account: { id: string; providerAccountId: string }, now: Date, runner: Pick<typeof db, "select"> = db): Promise<number> {
  const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
  const [{ n }] = await runner
    .select({ n: sql<number>`count(*)::int` })
    .from(sends)
    .where(
      and(
        eq(sends.linkedinAccountId, account.id),
        eq(sends.channel, "linkedin"),
        sql`${sends.stepNumber} > 1`,
        inArray(sends.status, SEND_COUNTED),
        sql`${sends.claimedAt} >= ${dayStart}::timestamptz`,
      ),
    );
  const [{ r }] = await runner
    .select({ r: sql<number>`count(*)::int` })
    .from(sendAttempts)
    .innerJoin(drafts, and(eq(drafts.id, sendAttempts.draftId), eq(drafts.organizationId, sendAttempts.organizationId)))
    .where(
      and(
        eq(drafts.channel, "linkedin"),
        inArray(sendAttempts.accountRef, [account.providerAccountId, account.id]),
        // ATTEMPT_COUNTED of conversations' send-attempt-status: outreach sits below conversations and cannot import it.
        inArray(sendAttempts.status, ["sending", "sent", "delivery_uncertain", "reconciled"]),
        sql`${sendAttempts.createdAt} >= ${dayStart}::timestamptz`,
      ),
    );
  return n + r;
}

/** LinkedIn said the account reached a limit: it sends nothing until `until`. */
export async function pauseLinkedInAccount(handle: DbHandle, accountId: string, until: Date): Promise<void> {
  await handle.update(linkedinAccounts).set({ limitReachedUntil: until }).where(eq(linkedinAccounts.id, accountId));
}

/** The provider no longer holds a session for the account. The error stays in its profile data for the Accounts page. */
export async function disconnectLinkedInAccount(handle: DbHandle, accountId: string, error: string): Promise<void> {
  await handle
    .update(linkedinAccounts)
    .set({ status: "disconnected", profileData: sql`jsonb_set(coalesce(${linkedinAccounts.profileData}, '{}'::jsonb), '{lastError}', to_jsonb(${error}::text))` })
    .where(eq(linkedinAccounts.id, accountId));
}
