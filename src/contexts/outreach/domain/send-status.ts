/**
 * Allowed status transitions of a `sends` row (campaign sends and test sends, email and LinkedIn).
 * `sent` and `failed` are final. `unknown` means the provider call may have gone out: it settles to
 * `sent` or `failed` only through reconciliation or a person's answer, never by a guess.
 * Every UPDATE of `sends.status` in a store filters on `SEND_FROM[target]`, so a late writer changes nothing.
 */
export type SendStatus = "sending" | "sent" | "failed" | "unknown";

export const SEND_FROM: Record<SendStatus, readonly SendStatus[]> = {
  sending: [],
  sent: ["sending", "unknown"],
  failed: ["sending", "unknown"],
  unknown: ["sending"],
};

/**
 * The worker that made the provider call settles its own row only from `sending`. A row that already
 * moved to `unknown`, `sent` or `failed` belongs to reconciliation or a person, so a late call changes nothing.
 */
export const SEND_FROM_CALL: readonly SendStatus[] = ["sending"];

/** Statuses the reconcilers pick up. */
export const SEND_UNRESOLVED: readonly SendStatus[] = ["sending", "unknown"];

export const SEND_FINAL: readonly SendStatus[] = ["sent", "failed"];

export function canMoveSend(from: SendStatus, to: SendStatus): boolean {
  return SEND_FROM[to].includes(from);
}
