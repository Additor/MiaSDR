export type Role = "owner" | "admin" | "member";

/** Roles are stored comma-separated when a member holds several. */
export function parseRoles(stored: string | null | undefined): Role[] {
  return (stored ?? "")
    .split(",")
    .map((r) => r.trim())
    .filter((r): r is Role => r === "owner" || r === "admin" || r === "member");
}

export function isOwnerOrAdmin(stored: string | null | undefined): boolean {
  const roles = parseRoles(stored);
  return roles.includes("owner") || roles.includes("admin");
}
