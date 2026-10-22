/**
 * Allowed status transitions of a `drafts` row (email and LinkedIn replies).
 * A draft is written as `awaiting_review`; `generating` is the column default and older rows may hold it. Approving
 * moves it to `sending`, and the send attempt settles it to `sent`, `delivery_uncertain`, `failed`, or back to
 * `awaiting_review` for a refusal the person can fix. A newer message, a stopped sequence or a closed record retires
 * an untouched draft to `stale`, and a person can discard one. `sent` and `discarded` are final.
 * Every UPDATE of `drafts.status` filters on `DRAFT_FROM[target]` or a named subset of it, so a late writer changes nothing.
 */
export const DRAFT_STATUSES = ["generating", "awaiting_review", "sending", "sent", "discarded", "stale", "failed", "delivery_uncertain"] as const;

export type DraftStatus = (typeof DRAFT_STATUSES)[number];

export const DRAFT_FROM: Record<DraftStatus, readonly DraftStatus[]> = {
  generating: [],
  awaiting_review: ["generating", "sending", "delivery_uncertain"],
  sending: ["awaiting_review"],
  delivery_uncertain: ["sending"],
  sent: ["sending", "delivery_uncertain"],
  failed: ["generating", "sending", "delivery_uncertain"],
  stale: ["generating", "awaiting_review", "failed"],
  discarded: ["generating", "awaiting_review", "failed", "stale"],
};

/** Drafts no send has touched. A newer draft for the same record and channel replaces them. */
export const UNSENT_DRAFT_STATUSES: readonly DraftStatus[] = ["generating", "awaiting_review"];

/** Drafts a stop can retire without touching a send: what `stale` moves from. */
export const RETIRABLE_DRAFT_STATUSES: readonly DraftStatus[] = DRAFT_FROM.stale;

/** Drafts with a provider call in flight or unresolved. Only the send attempt settles them. */
export const IN_FLIGHT_DRAFT_STATUSES: readonly DraftStatus[] = ["sending", "delivery_uncertain"];

/** Drafts that hold the record's reply slot: a new automatic draft waits until they settle. */
export const PENDING_DRAFT_STATUSES: readonly DraftStatus[] = [...UNSENT_DRAFT_STATUSES, ...IN_FLIGHT_DRAFT_STATUSES];

export function canMoveDraft(from: DraftStatus, to: DraftStatus): boolean {
  return DRAFT_FROM[to].includes(from);
}
