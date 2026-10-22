/**
 * An owner or admin can pause outreach for one organization from Settings, Organization. The pause lives in the
 * organization's `general` channel settings as `sendingPaused`, and both send engines read it inside their claim
 * transaction, so a paused organization claims no campaign email and no LinkedIn action. Replies a person approves
 * still send: they do not go through a claim.
 */
export interface SendPause {
  /** ISO time the pause started. */
  at: string;
  /** Name of the person who paused, as it was then. */
  byName: string | null;
}

export function readSendPause(general: Record<string, unknown> | null | undefined): SendPause | null {
  const value = general?.sendingPaused;
  if (!value || typeof value !== "object") return null;
  const { at, byName } = value as Record<string, unknown>;
  if (typeof at !== "string") return null;
  return { at, byName: typeof byName === "string" ? byName : null };
}
