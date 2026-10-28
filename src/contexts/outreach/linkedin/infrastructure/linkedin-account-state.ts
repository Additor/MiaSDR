import { eq, sql } from "drizzle-orm";
import type { DbHandle } from "@/platform/db/client";
import { linkedinAccounts } from "@/platform/db/schema";

/*
 * What a provider answer does to a LinkedIn account. Outreach owns `linkedin_accounts`; its campaign sends and
 * conversations' replies both hit the same limits and the same disconnects, and both record them here.
 */

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
