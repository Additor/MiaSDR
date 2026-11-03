/**
 * The status rules of a `reply_type_picks` row. The AI's pick goes in `auto_applied` when it applied, `proposed` when it waits
 * for a check, and `stale` or `failed` when it never applied. A person's decision moves a live pick to `accepted` or
 * `overridden`, undo moves an applied one to `rejected`, and a context version bump moves a held one to `stale`.
 * Every UPDATE of the status filters on `PICK_FROM[target]` (`pickMayBecome`), so a late writer changes nothing.
 */
export const PICK_STATUSES = ["proposed", "auto_applied", "accepted", "rejected", "overridden", "stale", "failed"] as const;

export type PickStatus = (typeof PICK_STATUSES)[number];

/** Picks whose type the conversation took. */
export const APPLIED_PICK_STATUSES = ["auto_applied", "accepted", "overridden"] as const satisfies readonly PickStatus[];

/** Picks a person's decision on the same reply and version settles. */
const LIVE_PICK_STATUSES = ["proposed", ...APPLIED_PICK_STATUSES] as const satisfies readonly PickStatus[];

export const PICK_FROM: Record<PickStatus, readonly PickStatus[]> = {
  proposed: [],
  auto_applied: [],
  failed: [],
  accepted: LIVE_PICK_STATUSES,
  overridden: LIVE_PICK_STATUSES,
  rejected: APPLIED_PICK_STATUSES,
  stale: ["proposed"],
};

export const isAppliedPick = (status: string): boolean => (APPLIED_PICK_STATUSES as readonly string[]).includes(status);

/** What a pick stores in `response` besides the provider's answer. SQL that reads a field names it the same way. */
export interface PickResponse {
  /** The conversation's lock before the pick applied, so undo gives it back. */
  previousLocked?: boolean;
  /** The reply asked to stop, as the AI or the reply's own words said. */
  stopRequested?: boolean;
  /** Why the pick waits for a person: a `HoldReason`, or a value an older version stored. */
  holdReason?: unknown;
}

/** Reads the stored JSON. A field of another type counts as missing. */
export function pickResponse(stored: unknown): PickResponse {
  const raw = (stored ?? {}) as Record<string, unknown>;
  return {
    ...(typeof raw.previousLocked === "boolean" ? { previousLocked: raw.previousLocked } : {}),
    ...(typeof raw.stopRequested === "boolean" ? { stopRequested: raw.stopRequested } : {}),
    ...(raw.holdReason !== undefined ? { holdReason: raw.holdReason } : {}),
  };
}

/** What a person can still do with a pick, against the conversation as it is now. */
export function pickFlags(
  pick: { messageId: string; status: string; appliedGroupKey: string | null; expectedContextVersion: number },
  conversation: { latestInboundMessageId: string | null; contextVersion: number },
): { latest: boolean; current: boolean; canUndo: boolean } {
  const latest = pick.messageId === conversation.latestInboundMessageId;
  return {
    latest,
    current: pick.expectedContextVersion === conversation.contextVersion && pick.status !== "stale",
    canUndo: latest && isAppliedPick(pick.status) && pick.appliedGroupKey !== null,
  };
}
