"use client";

import { createContext, useContext, type ReactNode } from "react";
import { formatDate, formatDateTime, formatUtc, relativeTime } from "@/shared/format-time";

/**
 * Timestamps show in the organization's time zone with the UTC original in the tooltip.
 *
 * - JSX (server or client component): `<Time value={date} />`, or `dateOnly` for "YYYY-MM-DD". The layout seeds the zone.
 * - Client code that needs a string (a table cell formatter, a label): `formatDateTime(value, useOrgTimeZone())`
 *   from "@/shared/format-time".
 * - Server code that needs a string: `formatDateTime(value, await getOrgTimeZone())` with `getOrgTimeZone` from
 *   "@/components/shell/org-time-zone".
 * - A filter input labelled UTC keeps UTC semantics; do not run its value through these helpers.
 */

const OrgTimeZoneContext = createContext("UTC");

/** Mounted once by the app layout. Anything below it reads the zone with `useOrgTimeZone`. */
export function OrgTimeZoneProvider({ timeZone, children }: { timeZone: string; children: ReactNode }) {
  return <OrgTimeZoneContext.Provider value={timeZone}>{children}</OrgTimeZoneContext.Provider>;
}

/** The organization's IANA zone for client components ("UTC" outside the provider). */
export function useOrgTimeZone(): string {
  return useContext(OrgTimeZoneContext);
}

/** `<time>` element: organization-zone text, ISO value in `dateTime`, UTC original in the tooltip. */
export function Time({
  value,
  zone,
  dateOnly = false,
  relativeTo,
  label,
  className,
  testId,
}: {
  value: Date | string | number;
  zone?: string;
  dateOnly?: boolean;
  /** Prints "5 min ago" against this instant. Pass the server's `now` so the server and the browser agree. The tooltip carries the exact time. */
  relativeTo?: Date | string | number;
  /**
   * Text the caller worded from the same instant, for a list with its own clock: the Inbox's "14:05" under a Today heading,
   * an Actions row's "Waiting 2 d". Word it on the server, or from a passed `now`, so the server and the browser agree. The
   * tooltip carries the exact time.
   */
  label?: string;
  className?: string;
  testId?: string;
}) {
  const orgZone = useOrgTimeZone();
  const timeZone = zone ?? orgZone;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const utc = formatUtc(date);
  const exact = timeZone === "UTC" ? utc : `${formatDateTime(date, timeZone)} ${timeZone}, ${utc}`;
  return (
    <time dateTime={date.toISOString()} title={relativeTo === undefined && label === undefined ? utc : exact} className={className} data-testid={testId}>
      {label ?? (relativeTo !== undefined ? relativeTime(date, relativeTo) : dateOnly ? formatDate(date, timeZone) : formatDateTime(date, timeZone))}
    </time>
  );
}
