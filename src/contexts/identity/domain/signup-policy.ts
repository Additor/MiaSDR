export interface SignupFacts {
  /** True once any user exists on the instance. */
  hasAnyUser: boolean;
  /** True when a pending, unexpired invitation exists for the email. */
  hasPendingInvitation: boolean;
}

/**
 * Applies to Better Auth sign-ups (email and Google). The first account comes from /setup, which writes its rows
 * directly, so nobody signs up while the instance is empty. After that, an account needs a pending invitation.
 */
export function mayCreateAccount(f: SignupFacts): boolean {
  return f.hasAnyUser && f.hasPendingInvitation;
}

/** Owners and admins of the oldest organization run the install. */
export const adminsTheFirstOrganization = (roles: string | null | undefined): boolean => Boolean(roles && /\b(owner|admin)\b/.test(roles));
