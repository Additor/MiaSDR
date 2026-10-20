import {
  deriveInvitationState,
  isInvitationId,
  type InvitationFacts,
  type InvitationViewerState,
} from "../domain/invitation-state";

export interface InvitationRecord extends InvitationFacts {
  id: string;
  role: string;
  organizationName: string;
  inviterName: string;
}

export interface InvitationReader {
  find(id: string): Promise<InvitationRecord | null>;
}

/**
 * What a viewer may see. Only the invited person gets role, inviter and expiry. Everyone else gets the
 * organization name, so the page can say which team the link belongs to. The invited address and the inviter's
 * email never leave this function.
 */
export type InvitationView =
  | { state: "not-found" }
  | { state: "anonymous" | "wrong-account"; organizationName: string; viewerEmail: string | null }
  | {
      state: "ready" | "expired" | "used" | "declined";
      organizationName: string;
      role: string;
      inviterName: string;
      expiresAt: string;
      viewerEmail: string;
    };

export async function getInvitationView(
  deps: { invitations: InvitationReader },
  input: { invitationId: string; viewerEmail: string | null; now?: Date },
): Promise<InvitationView> {
  if (!isInvitationId(input.invitationId)) return { state: "not-found" };
  const record = await deps.invitations.find(input.invitationId);
  const state: InvitationViewerState = deriveInvitationState(record, input.viewerEmail, input.now ?? new Date());
  if (state === "not-found" || !record) return { state: "not-found" };
  if (state === "anonymous" || state === "wrong-account") {
    return { state, organizationName: record.organizationName, viewerEmail: input.viewerEmail };
  }
  return {
    state,
    organizationName: record.organizationName,
    role: record.role,
    inviterName: record.inviterName,
    expiresAt: record.expiresAt.toISOString(),
    viewerEmail: input.viewerEmail ?? "",
  };
}
