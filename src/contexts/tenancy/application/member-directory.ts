import type { Actor } from "@/shared/errors";

/** A member of the organization as the pickers show them. */
export interface MemberChoice {
  userId: string;
  name: string;
}

/**
 * The organization's members, read by the contexts that assign work to one: a task assignee, a deal owner. Tenancy owns
 * `members`, so every such check and picker reads it here.
 */
export interface MemberDirectory {
  isMember(organizationId: string, userId: string): Promise<boolean>;
  /** Current members, by name. */
  list(organizationId: string): Promise<MemberChoice[]>;
}

/** The members an owner or assignee picker offers. Any member may read them. */
export function listMemberChoices(deps: { directory: MemberDirectory }, actor: Actor): Promise<MemberChoice[]> {
  return deps.directory.list(actor.organizationId);
}
