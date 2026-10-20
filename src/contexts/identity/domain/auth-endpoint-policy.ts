/**
 * Which Better Auth endpoints a browser may call over HTTP.
 *
 * The organization plugin mounts about 35 endpoints. Our own rules for renames, role changes, removals and
 * invitations live in the tenancy use cases, and an endpoint that skips them is a bypass (an admin could rename
 * without the owner check, change a role without the session reset, or remove the last owner). So every state
 * changing request needs an entry here. A path or method that is not listed is refused.
 *
 * Server code calls `auth().api.*` directly and does not pass through this list.
 */

/** `METHOD path`, path relative to `/api/auth`. Each entry names the caller. */
const ALLOWED_MUTATIONS: ReadonlySet<string> = new Set([
  // Sign-up, sign-in and sign-out forms.
  "POST /sign-up/email",
  "POST /sign-in/email",
  "POST /sign-in/social", // Google button, only works when GOOGLE_CLIENT_ID is set
  "POST /sign-out",
  // Verification and password reset pages.
  "POST /send-verification-email",
  "POST /request-password-reset",
  "POST /reset-password",
  // Accept invitation page. Better Auth checks that the invitation is addressed to the signed-in user.
  "POST /organization/accept-invitation",
  // Decline button on the same page. Better Auth checks that the invitation is addressed to the signed-in user.
  "POST /organization/reject-invitation",
]);

/** Methods that do not change state. Better Auth serves its GET endpoints (session, verify-email, OAuth callback) through these. */
const READ_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD"]);

export type AuthEndpointVerdict = { allowed: true } | { allowed: false; reason: string };

/** `/api/auth/organization/update/` becomes `/organization/update`. */
export function authEndpointPath(pathname: string): string {
  const path = pathname.replace(/^\/api\/auth(?=\/|$)/, "").replace(/\/{2,}/g, "/").replace(/(.)\/$/, "$1");
  return path === "" ? "/" : path;
}

export function checkAuthEndpoint(method: string, pathname: string): AuthEndpointVerdict {
  const verb = method.toUpperCase();
  if (READ_METHODS.has(verb)) return { allowed: true };
  if (ALLOWED_MUTATIONS.has(`${verb} ${authEndpointPath(pathname)}`)) return { allowed: true };
  return {
    allowed: false,
    reason: "This endpoint is not available. Use the MiaSDR settings pages to manage the organization and its members.",
  };
}

/** Exposed for tests that assert the list stays small. */
export const allowedAuthMutations = (): string[] => [...ALLOWED_MUTATIONS];
