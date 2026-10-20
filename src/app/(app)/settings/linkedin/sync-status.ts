import { formatDateTime, formatUtc } from "@/shared/format-time";

export interface StoredSyncStatus {
  lastSyncAt: string | null;
  lastSyncError: string | null;
}

/**
 * The status line under the account list. Times print in the organization's zone, which the caller passes in so the
 * server and the browser render the same text. `title` holds the UTC original for the tooltip.
 */
export function syncLine(sync: StoredSyncStatus | null, timeZone: string): { text: string; failed: boolean; title?: string } | null {
  if (!sync) return null;
  const when = sync.lastSyncAt ? formatDateTime(sync.lastSyncAt, timeZone) : "";
  const title = sync.lastSyncAt ? formatUtc(sync.lastSyncAt) || undefined : undefined;
  if (sync.lastSyncError) return { text: when ? `${sync.lastSyncError} Last synced ${when}.` : sync.lastSyncError, failed: true, title };
  if (when) return { text: `Last synced ${when}.`, failed: false, title };
  return { text: "Not synced yet. Accounts sync every hour.", failed: false };
}
