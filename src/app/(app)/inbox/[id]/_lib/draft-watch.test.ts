import { describe, expect, it } from "vitest";
import { DRAFT_POLL_INTERVAL_MS, DRAFT_WATCH_MS, initialWatch, isWatching, observe, watchedDraftStatus, type WatchSnapshot } from "./draft-watch";

const base: WatchSnapshot = { contextVersion: 3, draftStatus: null, workflowState: "action_required", drafting: false };

describe("draft watch", () => {
  it("stays idle on a fresh page with no draft in flight", () => {
    const state = initialWatch(base, 0);
    expect(isWatching(state, base, 0)).toBe(false);
    expect(observe(state, base, 5_000)).toEqual(state);
  });

  it("starts when the context version rises after a reclassification", () => {
    const state = initialWatch(base, 0);
    const bumped = { ...base, contextVersion: 4, drafting: true };
    const next = observe(state, bumped, 10_000);
    expect(next).toEqual({ version: 4, startedAt: 10_000 });
    expect(isWatching(next, bumped, 10_000)).toBe(true);
  });

  it("starts at mount when a draft is already generating or its job waits", () => {
    const generating = { ...base, draftStatus: "generating" };
    expect(isWatching(initialWatch(generating, 7), generating, 7)).toBe(true);
    const queued = { ...base, drafting: true };
    expect(isWatching(initialWatch(queued, 7), queued, 7)).toBe(true);
  });

  it("watches nothing after a change to a type that writes no draft", () => {
    const bumped = { ...base, contextVersion: 4 };
    const state = observe(initialWatch(base, 0), bumped, 1_000);
    expect(isWatching(state, bumped, 1_000)).toBe(false);
  });

  it("stops as soon as a draft awaits review, fails or is sent", () => {
    const state = observe(initialWatch(base, 0), { ...base, contextVersion: 4 }, 0);
    for (const draftStatus of ["awaiting_review", "failed", "sending", "sent", "delivery_uncertain"]) {
      expect(isWatching(state, { ...base, contextVersion: 4, draftStatus, drafting: true }, 3_000), draftStatus).toBe(false);
    }
    expect(isWatching(state, { ...base, contextVersion: 4, draftStatus: "generating" }, 3_000)).toBe(true);
  });

  it("stops when the record closed or errored, since no draft will come", () => {
    const state = observe(initialWatch(base, 0), { ...base, contextVersion: 4 }, 0);
    expect(isWatching(state, { ...base, contextVersion: 4, workflowState: "closed", drafting: true }, 3_000)).toBe(false);
    expect(isWatching(state, { ...base, contextVersion: 4, workflowState: "error", drafting: true }, 3_000)).toBe(false);
  });

  it("polls every 3 s and gives up at 45 s", () => {
    const bumped = { ...base, contextVersion: 4, drafting: true };
    const state = observe(initialWatch(base, 0), bumped, 1_000);
    let polls = 0;
    for (let now = 1_000; isWatching(state, bumped, now); now += DRAFT_POLL_INTERVAL_MS) polls++;
    expect(polls).toBe(DRAFT_WATCH_MS / DRAFT_POLL_INTERVAL_MS);
    expect(isWatching(state, bumped, 1_000 + DRAFT_WATCH_MS - 1)).toBe(true);
    expect(isWatching(state, bumped, 1_000 + DRAFT_WATCH_MS)).toBe(false);
  });

  it("a second reclassification inside a watch restarts the clock", () => {
    const first = observe(initialWatch(base, 0), { ...base, contextVersion: 4 }, 0);
    const second = observe(first, { ...base, contextVersion: 5 }, 30_000);
    expect(second.startedAt).toBe(30_000);
    expect(isWatching(second, { ...base, contextVersion: 5, drafting: true }, 60_000)).toBe(true);
  });

  it("ignores a lower or equal version and keeps a running watch", () => {
    const running = observe(initialWatch(base, 0), { ...base, contextVersion: 4 }, 2_000);
    expect(observe(running, { ...base, contextVersion: 4 }, 9_000)).toEqual(running);
    expect(observe(running, { ...base, contextVersion: 3 }, 9_000)).toEqual(running);
  });
});

describe("watchedDraftStatus", () => {
  it("reads the newest open draft of the current context version only, so an earlier sent draft does not end the watch", () => {
    const sentBefore = { conversationId: "c1", status: "sent", expectedContextVersion: 3 };
    expect(watchedDraftStatus([sentBefore], "c1", 4)).toBeNull();
    const generating = { conversationId: "c1", status: "generating", expectedContextVersion: 4 };
    expect(watchedDraftStatus([generating, sentBefore], "c1", 4)).toBe("generating");
    expect(watchedDraftStatus([{ ...generating, status: "stale" }, sentBefore], "c1", 4)).toBeNull();
    expect(watchedDraftStatus([{ ...generating, conversationId: "c2" }], "c1", 4)).toBeNull();
  });
});
