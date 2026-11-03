import { and, eq, sql, type SQL } from "drizzle-orm";
import { db, type DbHandle } from "@/platform/db/client";
import { mailboxes } from "@/platform/db/schema";

/**
 * A mailbox cannot send, as a provider said while sending. Campaign sends and replies report it the same way. `failed` stops
 * claims and starts the takeover clock (`unavailable_since`), and the hourly check or a person's Recheck brings it back.
 */
export async function markMailboxUnavailableTx(handle: DbHandle, where: SQL | undefined, error: string, now: Date): Promise<void> {
  await handle
    .update(mailboxes)
    .set({ status: "failed", lastError: error, lastTestedAt: now, unavailableSince: sql`coalesce(${mailboxes.unavailableSince}, ${now.toISOString()}::timestamptz)` })
    .where(sql`${where} and ${mailboxes.status} = 'connected'`);
}

/** The same for a reply, which knows the mailbox by its address. */
export function markAddressUnavailable(organizationId: string, emailAddress: string, error: string, now: Date): Promise<void> {
  return markMailboxUnavailableTx(db, and(eq(mailboxes.organizationId, organizationId), sql`lower(${mailboxes.emailAddress}) = ${emailAddress.toLowerCase()}`), error, now);
}
