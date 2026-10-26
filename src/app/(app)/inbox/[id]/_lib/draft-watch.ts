/**
 * Pure rules for the draft watch on the thread page. A type change bumps the record's context version and, when the type
 * writes a draft, queues a draft job; the draft arrives on a later tick, so the page refreshes every 3 s for up to 45 s while
 * the job waits or runs. A change to a type that writes no draft queues nothing, so nothing is watched. The client
 * component feeds these functions; nothing here touches the DOM or a timer.
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
  /** A draft job for the record is queued or running. */
  drafting: boolean;
}

export interface WatchState {
  /** Highest context version seen so far. */
  version: number;
  /** When the current watch began, or null when none runs. */
  startedAt: number | null;
}

const draftComing = (snapshot: WatchSnapshot) => snapshot.drafting || snapshot.draftStatus === "generating";

/** A draft job or a draft already generating when the page opens starts a watch; otherwise the page waits for a version bump. */
export function initialWatch(snapshot: WatchSnapshot, now: number): WatchState {
  return { version: snapshot.contextVersion, startedAt: draftComing(snapshot) ? now : null };
}

/** Called whenever fresh server data arrives. A higher context version means someone reclassified the thread. */
export function observe(state: WatchState, snapshot: WatchSnapshot, now: number): WatchState {
  if (snapshot.contextVersion > state.version) return { version: snapshot.contextVersion, startedAt: now };
  if (draftComing(snapshot) && state.startedAt === null) return { ...state, startedAt: now };
  return state;
}

export function isWatching(state: WatchState, snapshot: WatchSnapshot, now: number): boolean {
  if (state.startedAt === null) return false;
  if (now - state.startedAt >= DRAFT_WATCH_MS) return false;
  if (snapshot.draftStatus !== null && SETTLED_DRAFTS.has(snapshot.draftStatus)) return false;
  if (NO_DRAFT_STATES.has(snapshot.workflowState)) return false;
  return draftComing(snapshot);
}
