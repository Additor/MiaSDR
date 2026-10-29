export interface StoredSyncStatus {
  lastSyncAt: string | null;
  lastSyncError: string | null;
}

/**
 * The status line under the account list, as parts: the stored error, the last success for `Time` to print in the
 * organization's zone (with the UTC original in its tooltip), and whether the line reads as a failure.
 */
export function syncLine(sync: StoredSyncStatus | null): { error: string | null; lastSyncAt: string | null; failed: boolean } | null {
  if (!sync) return null;
  return { error: sync.lastSyncError, lastSyncAt: sync.lastSyncAt, failed: sync.lastSyncError !== null };
}
