/**
 * Allowed status transitions of a `send_attempts` row (email and LinkedIn replies).
 * `sent`, `reconciled` and `failed` are final. Only the worker that made the call writes `sent`, from `sending`.
 * `delivery_uncertain` moves to `reconciled` (the message was found, or a person confirmed it), to `failed`
 * (a person confirmed it did not go out), or stays. Every UPDATE of `send_attempts.status` filters on `ATTEMPT_FROM[target]`.
 * The drafts row follows the attempt inside the same transaction and only when the attempt moved.
 */
export type AttemptStatus = "prepared" | "sending" | "sent" | "failed" | "delivery_uncertain" | "reconciled";

export const ATTEMPT_FROM: Record<AttemptStatus, readonly AttemptStatus[]> = {
  prepared: [],
  sending: ["prepared"],
  sent: ["sending"],
  reconciled: ["sending", "delivery_uncertain"],
  failed: ["sending", "delivery_uncertain"],
  delivery_uncertain: ["sending"],
};

/**
 * A definite refusal or an unknown outcome reported by the worker that made the provider call applies only
 * to `sending`. `delivery_uncertain` leaves through a found message or a person's answer, never a late failure.
 */
export const ATTEMPT_FROM_CALL: readonly AttemptStatus[] = ["sending"];

export const ATTEMPT_FINAL: readonly AttemptStatus[] = ["sent", "reconciled", "failed"];

export function canMoveAttempt(from: AttemptStatus, to: AttemptStatus): boolean {
  return ATTEMPT_FROM[to].includes(from);
}

/** Attempts that sent or may have sent. A definite refusal used no quota. */
export const ATTEMPT_COUNTED: readonly AttemptStatus[] = ["sending", "sent", "delivery_uncertain", "reconciled"];
