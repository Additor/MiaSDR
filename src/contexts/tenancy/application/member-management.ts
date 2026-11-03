import type { DbHandle } from "@/platform/db/client";
import { normalizeEmail } from "@/shared/email";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError, type Actor } from "@/shared/errors";
import { canGrantRole, canManageMember, isRole, keepsAnOwner, type MemberView } from "../domain/member-rules";
import { isOwnerOrAdmin, type Role } from "../domain/roles";

export interface MemberRow extends MemberView {
  name: string;
  email: string;
  joinedAt: Date;
}

export interface InvitationRow {
  id: string;
  email: string;
  role: string;
  status: string;
  expiresAt: Date;
  createdAt: Date;
}

/**
 * Port. What agent access does inside a member change, in the same transaction. Agent access sits above tenancy and reads
 * its members, so `src/composition/members.ts` passes this in.
 */
export interface MemberAgentAccess {
  /** Runs before any member row lock, so a role change or a removal lands between agent actions, never inside one. */
  lock(tx: DbHandle, organizationId: string): Promise<void>;
  /** Ends what the removed member's agents hold. */
  memberRemoved(tx: DbHandle, removal: { organizationId: string; userId: string; actorUserId: string }): Promise<void>;
}

/** Member changes run inside one transaction that holds the organization's member rows, so two requests cannot both pass the last-owner check. */
export interface MemberTx {
  /** The transaction itself, for what other contexts let go of in the same commit. */
  handle: DbHandle;
  members(): Promise<MemberView[]>;
  setRole(memberId: string, role: Role): Promise<void>;
  /** Removes the member and ends their agent access; `actorUserId` is who the audit log names for the revoke. */
  remove(memberId: string, actorUserId: string): Promise<void>;
}

export interface MemberStore {
  list(organizationId: string): Promise<MemberRow[]>;
  hasMemberWithEmail(organizationId: string, email: string): Promise<boolean>;
  listPendingInvitations(organizationId: string): Promise<InvitationRow[]>;
  getInvitation(organizationId: string, id: string): Promise<InvitationRow | null>;
  cancelInvitation(organizationId: string, id: string): Promise<void>;
  transaction<T>(organizationId: string, run: (tx: MemberTx) => Promise<T>): Promise<T>;
}

/** Creates the invitation and sends the email. The adapter uses Better Auth's organization API. */
export interface InvitationGateway {
  invite(actor: Actor, input: { email: string; role: Role }): Promise<{ id: string }>;
}

export interface MemberDeps {
  members: MemberStore;
  invitations: InvitationGateway;
  /** What other contexts let go of when a member is removed, such as the LinkedIn accounts they owned. Runs in the removal's transaction. */
  released?: (tx: DbHandle, organizationId: string, userId: string) => Promise<void>;
}

function requireAdmin(actor: Actor) {
  if (!isOwnerOrAdmin(actor.role)) throw new ForbiddenError("Only an owner or admin can manage members.");
}

function enforce(result: { ok: boolean; reason?: string }) {
  if (!result.ok) throw new ForbiddenError(result.reason);
}

/** Any member may see who is in the organization. */
export function listMembers(deps: MemberDeps, actor: Actor): Promise<MemberRow[]> {
  return deps.members.list(actor.organizationId);
}

export async function listInvitations(deps: MemberDeps, actor: Actor): Promise<InvitationRow[]> {
  requireAdmin(actor);
  return deps.members.listPendingInvitations(actor.organizationId);
}

export async function inviteMember(deps: MemberDeps, actor: Actor, input: { email: string; role: string }): Promise<{ id: string }> {
  requireAdmin(actor);
  if (!isRole(input.role)) throw new ValidationError("Choose owner, admin or member.");
  enforce(canGrantRole(actor.role, input.role));
  const email = normalizeEmail(input.email);
  if (!email) throw new ValidationError("Enter a valid email address.");
  if (await deps.members.hasMemberWithEmail(actor.organizationId, email)) throw new ConflictError("This person is already a member.");
  return deps.invitations.invite(actor, { email, role: input.role });
}

export async function revokeInvitation(deps: MemberDeps, actor: Actor, id: string): Promise<void> {
  requireAdmin(actor);
  const invitation = await deps.members.getInvitation(actor.organizationId, id);
  if (!invitation) throw new NotFoundError("Invitation not found");
  if (invitation.status !== "pending") throw new ConflictError("This invitation is no longer pending.");
  enforce(canManageMember(actor.role, invitation.role));
  await deps.members.cancelInvitation(actor.organizationId, id);
}

export async function changeMemberRole(deps: MemberDeps, actor: Actor, memberId: string, role: string): Promise<void> {
  requireAdmin(actor);
  if (!isRole(role)) throw new ValidationError("Choose owner, admin or member.");
  await deps.members.transaction(actor.organizationId, async (tx) => {
    const all = await tx.members();
    const target = all.find((m) => m.id === memberId);
    if (!target) throw new NotFoundError("Member not found");
    enforce(canManageMember(actor.role, target.role));
    enforce(canGrantRole(actor.role, role));
    enforce(keepsAnOwner(all, memberId, role));
    await tx.setRole(memberId, role);
  });
}

export async function removeMember(deps: MemberDeps, actor: Actor, memberId: string): Promise<void> {
  requireAdmin(actor);
  await deps.members.transaction(actor.organizationId, async (tx) => {
    const all = await tx.members();
    const target = all.find((m) => m.id === memberId);
    if (!target) throw new NotFoundError("Member not found");
    if (target.userId === actor.userId) throw new ConflictError("You cannot remove yourself. Ask another owner or admin.");
    enforce(canManageMember(actor.role, target.role));
    enforce(keepsAnOwner(all, memberId, null));
    await tx.remove(memberId, actor.userId);
    await deps.released?.(tx.handle, actor.organizationId, target.userId);
  });
}
