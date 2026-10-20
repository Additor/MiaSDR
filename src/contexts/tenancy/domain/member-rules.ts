import { parseRoles, type Role } from "./roles";

export interface MemberView {
  id: string;
  userId: string;
  role: string;
}

export type RuleResult = { ok: true } | { ok: false; reason: string };
const ok: RuleResult = { ok: true };
const no = (reason: string): RuleResult => ({ ok: false, reason });

export const ASSIGNABLE_ROLES: Role[] = ["owner", "admin", "member"];

export function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ASSIGNABLE_ROLES as string[]).includes(value);
}

const isOwner = (stored: string) => parseRoles(stored).includes("owner");
const isAdminOrOwner = (stored: string) => parseRoles(stored).some((r) => r === "owner" || r === "admin");

/** Owners grant any role. Admins grant admin and member. Members grant none. */
export function canGrantRole(actorRole: string, role: Role): RuleResult {
  if (isOwner(actorRole)) return ok;
  if (!isAdminOrOwner(actorRole)) return no("Only an owner or admin can manage members.");
  return role === "owner" ? no("Only an owner can grant the owner role.") : ok;
}

/** Whether `actorRole` may touch a member who currently holds `targetRole` (change or remove). */
export function canManageMember(actorRole: string, targetRole: string): RuleResult {
  if (!isAdminOrOwner(actorRole)) return no("Only an owner or admin can manage members.");
  if (isOwner(targetRole) && !isOwner(actorRole)) return no("Only an owner can change or remove an owner.");
  return ok;
}

/** Roles after `targetId` is changed to `newRole`, or removed when `newRole` is null, must still contain an owner. */
export function keepsAnOwner(members: MemberView[], targetId: string, newRole: Role | null): RuleResult {
  const remaining = members.filter((m) => m.id !== targetId);
  const target = members.find((m) => m.id === targetId);
  const ownersLeft = remaining.filter((m) => isOwner(m.role)).length + (target && newRole === "owner" ? 1 : 0);
  return ownersLeft > 0 ? ok : no("An organization needs at least one owner. Make someone else an owner first.");
}
