import { describe, expect, it } from "vitest";
import { ValidationError } from "@/shared/errors";
import {
  QUEUE_DEFAULT_LIMIT,
  QUEUE_GROUPS,
  QUEUE_MAX_LIMIT,
  clampQueueLimit,
  decodeQueueCursor,
  encodeQueueCursor,
  isInQueue,
  isWorkClear,
  groupsAfter,
  parseQueueFilter,
  pickNextQueueItem,
  pickReviewOf,
  queueGroupOf,
  scopeOf,
  waitingSince,
  type PickReviewFacts,
  type QueueFacts,
  type WaitingFacts,
} from "./action-queue";

const ID = "0b7e7a7e-1d2f-4c3a-8b4d-5e6f7a8b9c0d";
const NOW = new Date("2026-10-20T09:00:00Z");

const facts = (partial: Partial<QueueFacts> = {}): QueueFacts => ({
  workflowState: "action_required",
  nextActionAt: null,
  hasProblemDraft: false,
  hasFailedJob: false,
  hasDraftToReview: false,
  hasReplyTypePickToReview: false,
  hasOpenTask: false,
  ...partial,
});

describe("queue group and membership", () => {
  it("picks the first match of problem, reply, classification, follow_up, next_step", () => {
    expect(queueGroupOf(facts())).toBe("next_step");
    expect(queueGroupOf(facts({ workflowState: "waiting" }))).toBe("follow_up");
    expect(queueGroupOf(facts({ hasReplyTypePickToReview: true }))).toBe("classification");
    expect(queueGroupOf(facts({ hasReplyTypePickToReview: true, hasDraftToReview: true }))).toBe("reply");
    expect(queueGroupOf(facts({ hasDraftToReview: true, hasProblemDraft: true }))).toBe("problem");
    expect(queueGroupOf(facts({ hasDraftToReview: true, hasFailedJob: true }))).toBe("problem");
    expect(queueGroupOf(facts({ workflowState: "error", hasDraftToReview: true }))).toBe("problem");
    expect(queueGroupOf(facts({ workflowState: "waiting", hasReplyTypePickToReview: true }))).toBe("classification");
  });

  it("admits action_required and error records, and waiting records whose time has come", () => {
    expect(isInQueue(facts(), NOW)).toBe(true);
    expect(isInQueue(facts({ workflowState: "error" }), NOW)).toBe(true);
    expect(isInQueue(facts({ workflowState: "waiting", nextActionAt: new Date("2026-10-20T09:00:00Z") }), NOW)).toBe(true);
    expect(isInQueue(facts({ workflowState: "waiting", nextActionAt: new Date("2026-10-20T09:00:01Z") }), NOW)).toBe(false);
    expect(isInQueue(facts({ workflowState: "waiting", nextActionAt: null }), NOW)).toBe(false);
    for (const workflowState of ["unclassified", "classifying", "idle", "paused", "closed"]) {
      expect(isInQueue(facts({ workflowState, hasDraftToReview: true, hasProblemDraft: true }), NOW)).toBe(false);
    }
  });

  it("leaves a next_step record out while it has an open task, and keeps every other group", () => {
    expect(isInQueue(facts({ hasOpenTask: true }), NOW)).toBe(false);
    expect(isInQueue(facts({ hasOpenTask: true, hasDraftToReview: true }), NOW)).toBe(true);
    expect(isInQueue(facts({ hasOpenTask: true, hasReplyTypePickToReview: true }), NOW)).toBe(true);
    expect(isInQueue(facts({ hasOpenTask: true, workflowState: "error" }), NOW)).toBe(true);
    expect(isInQueue(facts({ hasOpenTask: true, workflowState: "waiting", nextActionAt: new Date("2026-10-19T09:00:00Z") }), NOW)).toBe(true);
  });
});

describe("action queue domain", () => {
  it("clamps the page size to 1..200 and defaults to 50", () => {
    expect(clampQueueLimit(undefined)).toBe(QUEUE_DEFAULT_LIMIT);
    expect(clampQueueLimit("abc")).toBe(QUEUE_DEFAULT_LIMIT);
    expect(clampQueueLimit(0)).toBe(QUEUE_DEFAULT_LIMIT);
    expect(clampQueueLimit("25")).toBe(25);
    expect(clampQueueLimit(9999)).toBe(QUEUE_MAX_LIMIT);
  });

  it("round-trips a cursor with microsecond precision and rejects anything else", () => {
    const cursor = { sortKey: "2026-10-14 10:00:00.123456+00", recordId: ID };
    expect(decodeQueueCursor(encodeQueueCursor(cursor))).toEqual(cursor);
    expect(() => decodeQueueCursor("nope")).toThrow(ValidationError);
    expect(() => decodeQueueCursor(Buffer.from(JSON.stringify(["'; drop table records;--", ID])).toString("base64url"))).toThrow(ValidationError);
    expect(() => decodeQueueCursor(Buffer.from(JSON.stringify(["2026-10-14 10:00:00+00", "x"])).toString("base64url"))).toThrow(ValidationError);
    // A cursor from the newest-first order has two elements. Continuing it in the oldest-first order would skip or repeat items.
    expect(() => decodeQueueCursor(Buffer.from(JSON.stringify(["2026-10-14 10:00:00+00", ID])).toString("base64url"))).toThrow(/Reload the queue/);
    expect(() => decodeQueueCursor(Buffer.from(JSON.stringify(["x", "2026-10-14 10:00:00+00", ID])).toString("base64url"))).toThrow(ValidationError);
  });

  it("reads a bare due date as a day in the organization's zone", () => {
    const f = parseQueueFilter({ dueBefore: "2026-10-15", dueAfter: "2026-10-01" }, "Asia/Seoul");
    expect(f.dueBefore?.toISOString()).toBe("2026-10-15T14:59:59.999Z");
    expect(f.dueAfter?.toISOString()).toBe("2026-09-30T15:00:00.000Z");
    // A full timestamp is taken as it is, in any zone.
    expect(parseQueueFilter({ dueBefore: "2026-10-15T08:00:00Z" }, "Asia/Seoul").dueBefore?.toISOString()).toBe("2026-10-15T08:00:00.000Z");
    expect(() => parseQueueFilter({ dueBefore: "2026-02-31" }, "Asia/Seoul")).toThrow(ValidationError);
  });

  it("parses filters and reads a bare due-before date as the end of that day", () => {
    expect(parseQueueFilter({})).toEqual({});
    const f = parseQueueFilter({ category: "interested", channel: "email", group: "reply", replyTypeId: ID, dueBefore: "2026-10-15", dueAfter: "2026-10-01" });
    expect(f).toMatchObject({ groupKey: "interested", channel: "email", group: "reply", replyTypeId: ID });
    expect(f.dueBefore?.toISOString()).toBe("2026-10-15T23:59:59.999Z");
    expect(f.dueAfter?.toISOString()).toBe("2026-10-01T00:00:00.000Z");
    expect(parseQueueFilter({ errorsOnly: "1" }).errorsOnly).toBe(true);
    expect(() => parseQueueFilter({ errorsOnly: "1", group: "reply" })).toThrow(ValidationError);
  });
});

describe("waiting since", () => {
  const at = (iso: string) => new Date(iso);
  const waiting = (partial: Partial<WaitingFacts> = {}): WaitingFacts => ({
    lastInboundAt: at("2026-10-18T08:00:00Z"),
    lastInteractionAt: at("2026-10-19T08:00:00Z"),
    createdAt: at("2026-10-01T08:00:00Z"),
    nextActionAt: at("2026-10-17T08:00:00Z"),
    failedAt: at("2026-10-19T12:00:00Z"),
    ...partial,
  });

  it("starts the clock of a reply, a classification and a next step at the last inbound message", () => {
    for (const group of ["reply", "classification", "next_step"] as const) {
      expect(waitingSince(group, waiting())).toEqual({ at: at("2026-10-18T08:00:00Z"), basis: "inbound" });
    }
  });

  it("does not restart the clock when a draft is written again, because only inbound time counts", () => {
    // `failedAt` and `lastInteractionAt` move when a draft is regenerated or a reply goes out; `lastInboundAt` does not.
    const regenerated = waiting({ lastInteractionAt: at("2026-10-20T07:00:00Z"), failedAt: at("2026-10-20T07:00:00Z") });
    expect(waitingSince("reply", regenerated)).toEqual(waitingSince("reply", waiting()));
  });

  it("falls back from the last inbound to the last interaction to the creation time", () => {
    expect(waitingSince("reply", waiting({ lastInboundAt: null })).at).toEqual(at("2026-10-19T08:00:00Z"));
    expect(waitingSince("reply", waiting({ lastInboundAt: null, lastInteractionAt: null })).at).toEqual(at("2026-10-01T08:00:00Z"));
  });

  it("starts a problem at its failure and a follow-up at the time it came due", () => {
    expect(waitingSince("problem", waiting())).toEqual({ at: at("2026-10-19T12:00:00Z"), basis: "failure" });
    expect(waitingSince("follow_up", waiting())).toEqual({ at: at("2026-10-17T08:00:00Z"), basis: "due" });
    expect(waitingSince("follow_up", waiting({ nextActionAt: null }))).toEqual({ at: at("2026-10-18T08:00:00Z"), basis: "due" });
  });
});

describe("work totals", () => {
  const none = { queue: 0, tasks: 0, uncertainCampaignSends: 0, unmatchedSenders: 0, deadLetters: 0 };

  it("is clear only when every source is empty", () => {
    expect(isWorkClear(none)).toBe(true);
    for (const key of Object.keys(none) as Array<keyof typeof none>) {
      expect(isWorkClear({ ...none, [key]: 1 })).toBe(false);
    }
  });
});

describe("next queue item", () => {
  const items = ["a", "b", "c", "d"].map((recordId) => ({ recordId }));

  it("takes the first candidate that is not the open item", () => {
    expect(pickNextQueueItem(items, "a")).toEqual({ recordId: "b" });
    expect(pickNextQueueItem(items, "c")).toEqual({ recordId: "a" });
    expect(pickNextQueueItem(items, "handled")).toEqual({ recordId: "a" });
  });

  it("answers null when nothing else waits", () => {
    expect(pickNextQueueItem([], "a")).toBeNull();
    expect(pickNextQueueItem([{ recordId: "a" }], "a")).toBeNull();
  });

  it("searches the groups below the item, then the ones above, then its own", () => {
    expect(groupsAfter("reply")).toEqual(["follow_up", "classification", "next_step", "problem", "reply"]);
    expect(groupsAfter("classification")).toEqual(["next_step", "problem", "reply", "follow_up", "classification"]);
    expect(groupsAfter("problem")).toEqual(["reply", "follow_up", "classification", "next_step", "problem"]);
    for (const group of QUEUE_GROUPS) expect([...groupsAfter(group)].sort()).toEqual([...QUEUE_GROUPS].sort());
  });
});

describe("queue scopes", () => {
  const ME = "11111111-1111-4111-8111-111111111111";
  const YOU = "22222222-2222-4222-8222-222222222222";

  it("splits by assignee into three scopes that do not overlap", () => {
    expect(scopeOf(ME, ME)).toBe("mine");
    expect(scopeOf(null, ME)).toBe("unassigned");
    expect(scopeOf(YOU, ME)).toBe("others");
    for (const assignedTo of [ME, YOU, null]) {
      const scopes = (["mine", "unassigned", "others"] as const).filter((scope) => scopeOf(assignedTo, ME) === scope);
      expect(scopes).toHaveLength(1);
    }
  });

  it("parses a scope and refuses one it does not know", () => {
    expect(parseQueueFilter({ scope: "mine" }).scope).toBe("mine");
    expect(parseQueueFilter({ scope: "" }).scope).toBeUndefined();
    expect(() => parseQueueFilter({ scope: "everyone" })).toThrow(ValidationError);
  });
});

describe("what an AI pick waits for", () => {
  const pick = (partial: Partial<PickReviewFacts> = {}): PickReviewFacts => ({
    status: "proposed",
    current: true,
    hasProposedType: true,
    proposedSystemRole: null,
    stopRequested: false,
    acknowledged: false,
    appliedIsCurrentType: false,
    checkMode: "before",
    stopped: false,
    ...partial,
  });
  const applied = (partial: Partial<PickReviewFacts> = {}) => pick({ status: "auto_applied", appliedIsCurrentType: true, checkMode: "after", ...partial });

  it("asks to accept a current held pick, and nothing once the record version moved on", () => {
    expect(pickReviewOf(pick())).toBe("held");
    expect(pickReviewOf(pick({ current: false }))).toBeNull();
    expect(pickReviewOf(pick({ hasProposedType: false }))).toBeNull();
    expect(pickReviewOf(pick({ status: "stale", current: false }))).toBeNull();
  });

  it("asks Looks right only for an applied pick decided with Check after, still the record's type, not looked at", () => {
    expect(pickReviewOf(applied())).toBe("looks_right");
    expect(pickReviewOf(applied({ checkMode: null }))).toBe("looks_right");
    expect(pickReviewOf(applied({ checkMode: "skip" }))).toBeNull();
    expect(pickReviewOf(applied({ checkMode: "before" }))).toBeNull();
    expect(pickReviewOf(applied({ acknowledged: true }))).toBeNull();
    expect(pickReviewOf(applied({ appliedIsCurrentType: false }))).toBeNull();
    for (const status of ["accepted", "overridden", "rejected", "failed"]) expect(pickReviewOf(applied({ status }))).toBeNull();
  });

  it("turns an open pick that reads as a stop request into a stop review, unless contact already stopped", () => {
    expect(pickReviewOf(pick({ proposedSystemRole: "stop_request" }))).toBe("stop_review");
    expect(pickReviewOf(pick({ stopRequested: true }))).toBe("stop_review");
    expect(pickReviewOf(applied({ stopRequested: true, checkMode: "skip" }))).toBe("stop_review");
    // Do not contact or a suppressed address: nothing is left to stop, and a held stop request is not offered for Accept.
    expect(pickReviewOf(pick({ proposedSystemRole: "stop_request", stopped: true }))).toBeNull();
    expect(pickReviewOf(pick({ stopRequested: true, stopped: true }))).toBe("held");
    expect(pickReviewOf(applied({ stopRequested: true, stopped: true }))).toBe("looks_right");
    // A stop request whose record moved on is answered.
    expect(pickReviewOf(pick({ proposedSystemRole: "stop_request", current: false }))).toBeNull();
  });
});
