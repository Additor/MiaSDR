export type SignupMode = "open" | "invite-only";

export interface SignupFacts {
  mode: SignupMode;
  /** True once any user exists on the instance. */
  hasAnyUser: boolean;
  /** True when a pending, unexpired invitation exists for the email. */
  hasPendingInvitation: boolean;
}

/**
 * Applies to Better Auth sign-ups (email and Google). The first account comes
 * from /setup, which writes its rows directly, so no mode allows a sign-up
 * while the instance is empty. After that, open instances accept anyone and
 * invite-only instances accept an email with a pending invitation.
 */
export function mayCreateAccount(f: SignupFacts): boolean {
  if (!f.hasAnyUser) return false;
  if (f.mode === "open") return true;
  return f.hasPendingInvitation;
}

/** Whether the "create account" link is offered to an anonymous visitor. An empty instance sends them to /setup instead. */
export function publicSignupAvailable(f: Pick<SignupFacts, "mode" | "hasAnyUser">): boolean {
  return f.mode === "open" && f.hasAnyUser;
}

export interface OrganizationCreationFacts {
  mode: SignupMode;
  /** Roles of the user in the oldest organization; null if no organization exists yet. */
  rolesInFirstOrganization: string | null | undefined;
  organizationExists: boolean;
}

/** In invite-only mode only owners and admins of the first organization may create more. */
export function mayCreateOrganization(f: OrganizationCreationFacts): boolean {
  if (f.mode === "open") return true;
  if (!f.organizationExists) return true;
  return Boolean(f.rolesInFirstOrganization && /\b(owner|admin)\b/.test(f.rolesInFirstOrganization));
}
