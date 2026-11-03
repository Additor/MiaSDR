/**
 * Where a mailbox stands (`mailboxes.status`). Mirrors the `mailboxes_status_ck` check. Only `connected` sends.
 * `disabled` is a person's choice, so only that person's Enable ends it: a check that was already running, or a Recheck, changes nothing.
 * Every write of the status names the statuses it moves from, so a late writer changes nothing.
 */
export const MAILBOX_STATUSES = ["connected", "failed", "disabled"] as const;
export type MailboxStatus = (typeof MAILBOX_STATUSES)[number];

/** A provider's answer settles a mailbox in these statuses. */
export const MAILBOX_CHECK_FROM: readonly MailboxStatus[] = ["connected", "failed"];
/** Enable verifies a disabled mailbox, and the answer moves it from here. */
export const MAILBOX_ENABLE_FROM: readonly MailboxStatus[] = ["disabled"];
export const MAILBOX_DISABLE_FROM: readonly MailboxStatus[] = ["connected", "failed"];
