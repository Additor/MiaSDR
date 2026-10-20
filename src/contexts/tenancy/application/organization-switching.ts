import { NotFoundError } from "@/shared/errors";
import type { ActiveOrganizationGateway } from "./create-organization";

export interface MembershipRow {
  id: string;
  name: string;
  slug: string;
  role: string;
}

export interface MembershipStore {
  /** The user's own memberships, oldest first. */
  forUser(userId: string): Promise<MembershipRow[]>;
}

export interface SwitchingDeps {
  memberships: MembershipStore;
  active: ActiveOrganizationGateway;
  mayCreate: (userId: string) => Promise<boolean>;
}

export interface OrganizationListItem extends MembershipRow {
  active: boolean;
}

export interface MyOrganizations {
  organizations: OrganizationListItem[];
  canCreate: boolean;
}

/**
 * Only the caller's memberships. The active one is the session's organization when the user still belongs to it,
 * otherwise the oldest membership, which is where `resolveOrgContext` lands as well.
 */
export async function listMyOrganizations(deps: SwitchingDeps, user: { userId: string; activeOrganizationId: string | null }): Promise<MyOrganizations> {
  const rows = await deps.memberships.forUser(user.userId);
  const activeId = rows.some((r) => r.id === user.activeOrganizationId) ? user.activeOrganizationId : (rows[0]?.id ?? null);
  return {
    organizations: rows.map((r) => ({ ...r, active: r.id === activeId })),
    canCreate: await deps.mayCreate(user.userId),
  };
}

/** A non-member gets the same 404 as an unknown id: the answer does not reveal which organizations exist. */
export async function switchOrganization(deps: SwitchingDeps, user: { userId: string }, organizationId: string): Promise<{ id: string }> {
  const rows = await deps.memberships.forUser(user.userId);
  if (!rows.some((r) => r.id === organizationId)) throw new NotFoundError("Organization not found");
  await deps.active.set(organizationId);
  return { id: organizationId };
}
