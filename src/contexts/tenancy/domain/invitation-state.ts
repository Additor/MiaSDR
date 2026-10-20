/**
 * What the accept-invitation page shows, derived from the invitation row and the person looking at it.
 *
 * A viewer whose email differs from the invited address learns the organization name and nothing else, not even
 * whether the invitation is pending, used or expired. An anonymous viewer gets the same minimum.
 */

export type InvitationState = "ready" | "wrong-account" | "expired" | "used" | "declined" | "not-found";

/** `anonymous` is a viewer without a session. The page asks them to sign in; the API answers 401. */
export type InvitationViewerState = InvitationState | "anonymous";

export interface InvitationFacts {
  /** pending | accepted | rejected | canceled (Better Auth's values). */
  status: string;
  expiresAt: Date;
  /** The invited address. */
  email: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A path segment that cannot name a row. Postgres would answer 22P02 for it. */
export const isInvitationId = (value: string): boolean => UUID.test(value);

const sameAddress = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * `viewerEmail` is null for a visitor without a session. `invitation` is null when no row matches.
 * A canceled invitation reads as not found: the inviter withdrew it, and the page owes nobody more detail.
 */
export function deriveInvitationState(
  invitation: InvitationFacts | null,
  viewerEmail: string | null,
  now: Date,
): InvitationViewerState {
  if (!invitation || invitation.status === "canceled") return "not-found";
  if (viewerEmail === null) return "anonymous";
  if (!sameAddress(invitation.email, viewerEmail)) return "wrong-account";
  if (invitation.status === "accepted") return "used";
  if (invitation.status === "rejected") return "declined";
  if (invitation.expiresAt.getTime() <= now.getTime()) return "expired";
  return "ready";
}
