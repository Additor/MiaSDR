/**
 * Pure rules for the "Drafting a reply..." watch on the thread page. A reclassification bumps the record's
 * context version and queues a fresh draft job; the draft arrives on a later tick, so the page refreshes every
 * 3 s for up to 45 s. The client component feeds these functions; nothing here touches the DOM or a timer.
 */

export const DRAFT_POLL_INTERVAL_MS = 3_000;
export const DRAFT_WATCH_MS = 45_000;

/** A draft in one of these states is the answer the watch waited for. */
const SETTLED_DRAFTS = new Set(["awaiting_review", "sending", "sent", "failed", "delivery_uncertain"]);
/** No draft is coming for a record in these states. */
const NO_DRAFT_STATES = new Set(["closed", "error"]);

export interface WatchSnapshot {
  contextVersion: number;
  /** Newest draft that is neither discarded nor stale. */
  draftStatus: string | null;
  workflowState: string;
}

export interface WatchState {
  /** Highest context version seen so far. */
  version: number;
  /** When the current watch began, or null when none runs. */
  startedAt: number | null;
}

/** A draft already generating when the page opens starts a watch; otherwise the page waits for a version bump. */
export function initialWatch(snapshot: WatchSnapshot, now: number): WatchState {
  return { version: snapshot.contextVersion, startedAt: snapshot.draftStatus === "generating" ? now : null };
}

/** Called whenever fresh server data arrives. A higher context version means someone reclassified the thread. */
export function observe(state: WatchState, snapshot: WatchSnapshot, now: number): WatchState {
  if (snapshot.contextVersion > state.version) return { version: snapshot.contextVersion, startedAt: now };
  if (snapshot.draftStatus === "generating" && state.startedAt === null) return { ...state, startedAt: now };
  return state;
}

export function isWatching(state: WatchState, snapshot: WatchSnapshot, now: number): boolean {
  if (state.startedAt === null) return false;
  if (now - state.startedAt >= DRAFT_WATCH_MS) return false;
  if (snapshot.draftStatus !== null && SETTLED_DRAFTS.has(snapshot.draftStatus)) return false;
  return !NO_DRAFT_STATES.has(snapshot.workflowState);
}
