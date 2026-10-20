import { flag } from "./env";

/**
 * Single parser for `PAUSE_OUTBOUND`. Reads the process environment on every call, not the cached `env()`, so the
 * send engines and the queue build see the current value. A value `flag()` rejects counts as paused: an unreadable
 * brake stays engaged, and the server logs the typo at start.
 */
export function isOutboundPaused(): boolean {
  try {
    return flag(process.env.PAUSE_OUTBOUND, false, "PAUSE_OUTBOUND");
  } catch {
    return true;
  }
}

/** True when `PAUSE_OUTBOUND` is set to a value that is not a boolean word. The pause is then on. */
export function isOutboundPauseUnreadable(): boolean {
  try {
    flag(process.env.PAUSE_OUTBOUND, false, "PAUSE_OUTBOUND");
    return false;
  } catch {
    return true;
  }
}
