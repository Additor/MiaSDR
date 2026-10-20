/*
 * Handlers that answer 400 to a malformed body before they check the caller's role (a member should get 403).
 * Unit D5 moved the permission check in front of the body parse (`withAdmin` in src/shared/api.ts) and emptied this
 * list. The matrix asserts it stays empty: a new admin-only handler must use `withAdmin` instead of being listed here.
 *
 * Format: `METHOD route-key`.
 */
export const PERMISSION_AFTER_VALIDATION: readonly string[] = [];
