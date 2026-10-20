export interface PinnedMailboxState {
  /** The mailbox row's status, or null when the row no longer exists. */
  status: string | null;
  /** When the mailbox last stopped being connected. Null for rows from before this was recorded. */
  unavailableSince: Date | null;
}

/** Instant before which an unavailable mailbox counts as unable for longer than the takeover delay. */
export function takeoverCutoff(now: Date, afterHours: number): Date {
  return new Date(now.getTime() - afterHours * 60 * 60_000);
}

/**
 * Whether another mailbox may claim a due follow-up that is pinned to `pinned`.
 * Only a mailbox that is not connected (disabled, failed, still connecting) or gone counts as unable.
 * A connected mailbox that is outside working hours, throttled or at its daily limit is merely busy,
 * so it never triggers a takeover. The unable period starts when the status left `connected`; without
 * that record (removed row, old data) it starts when the follow-up became due.
 */
export function canTakeOver(now: Date, afterHours: number, pinned: PinnedMailboxState, followUpDueAt: Date): boolean {
  if (pinned.status === "connected") return false;
  const since = pinned.status === null ? followUpDueAt : (pinned.unavailableSince ?? followUpDueAt);
  return since.getTime() <= takeoverCutoff(now, afterHours).getTime();
}
