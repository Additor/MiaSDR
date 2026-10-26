/*
 * The columns of the people list and the per-user choice of which ones show. Name always shows. The choice lives in a
 * cookie, so the server renders the saved set on the first paint and nothing flashes. The cookie name carries the
 * user id, so two people on one browser keep their own sets.
 */

export const OPTIONAL_COLUMNS = ["contact", "campaign", "lastContact", "email", "title", "company", "added"] as const;
export type OptionalColumn = (typeof OPTIONAL_COLUMNS)[number];

export const COLUMN_LABELS: Record<OptionalColumn, string> = {
  contact: "Reach",
  campaign: "Status",
  lastContact: "Last contact",
  email: "Email",
  title: "Title",
  company: "Company",
  added: "Added",
};

export const DEFAULT_COLUMNS: readonly OptionalColumn[] = OPTIONAL_COLUMNS;

/** Column ids that were renamed. A cookie saved before the rename keeps working: the old id reads as the new one. */
const RENAMED_COLUMNS: Record<string, OptionalColumn> = { channels: "contact" };

const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;

export function columnsCookieName(userId: string): string {
  return `leads-columns-${userId.replace(/[^\w-]/g, "")}`;
}

/** Reads the cookie value. Anything that is not a list of known columns falls back to all of them. */
export function parseColumns(value: string | null | undefined): OptionalColumn[] {
  if (value === null || value === undefined) return [...DEFAULT_COLUMNS];
  const wanted = new Set(value.split(".").map((key) => RENAMED_COLUMNS[key] ?? key));
  // "-" is the saved empty set: Name alone.
  const known = OPTIONAL_COLUMNS.filter((column) => wanted.has(column));
  if (known.length === 0 && value !== "-") return [...DEFAULT_COLUMNS];
  return known;
}

/** The cookie value for a set: column keys joined by "." in display order, or "-" for none. */
export function serializeColumns(columns: readonly OptionalColumn[]): string {
  const ordered = OPTIONAL_COLUMNS.filter((column) => columns.includes(column));
  return ordered.length === 0 ? "-" : ordered.join(".");
}

export function toggleColumn(columns: readonly OptionalColumn[], column: OptionalColumn, visible: boolean): OptionalColumn[] {
  const next = new Set(columns);
  if (visible) next.add(column);
  else next.delete(column);
  return OPTIONAL_COLUMNS.filter((c) => next.has(c));
}

/** The `document.cookie` assignment that stores a set for a year. */
export function columnsCookie(userId: string, columns: readonly OptionalColumn[]): string {
  return `${columnsCookieName(userId)}=${serializeColumns(columns)}; path=/; max-age=${ONE_YEAR_SECONDS}; samesite=lax`;
}
