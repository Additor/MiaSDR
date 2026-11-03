import { describe, expect, it } from "vitest";
import { DEFAULT_REPLY_TYPES } from "./default-reply-types";
import {
  AI_PICK_CONFIDENCE_FLOOR,
  decideReplyType,
  holdReasonOf,
  typeChangeOutcome,
  type ReplyType,
  type ReplyTypeFacts,
  type TypeRules,
} from "./reply-type";
import { settlesAfterAiPick } from "./workflow-state";

/** An AI pick at high confidence on an email reply of a campaign that drafts follow-ups: every rule is in play. */
const facts: ReplyTypeFacts = {
  stopRequested: false,
  isContact: false,
  campaignMode: "ai_drafts",
  channel: "email",
  confidence: 0.99,
  locked: false,
  currentType: null,
};

const type = (rules: Partial<TypeRules> = {}, over: Partial<ReplyType> = {}): ReplyType => ({
  id: "t1",
  key: "demo_request",
  name: "Demo request",
  groupKey: "interested",
  systemRole: null,
  rules: { replyDraft: true, followUps: "continue", ...rules },
  ...over,
});

type SeededDecision = [key: string, hold: "stop_request" | null, wantsDraft: boolean, followUps: "continue" | "stop", settles: boolean];

/**
 * What an AI pick of each default type decides, with `facts` above. The values are written out so a change to the
 * seeded rules or to `decideReplyType` shows up here. `settles` is `settlesAfterAiPick` from `action_required`.
 */
const SEEDED: readonly SeededDecision[] = [
  ["information_requested", null, true, "continue", false],
  ["case_study", null, true, "continue", false],
  ["demo_request", null, true, "continue", false],
  ["meeting_requested", null, true, "continue", false],
  ["meeting_no_show", null, true, "continue", false],
  ["meeting_done", null, true, "continue", false],
  ["trial_requested", null, true, "continue", false],
  ["trial_user", null, true, "continue", false],
  ["customer", null, true, "stop", false],
  ["do_not_contact", "stop_request", false, "stop", false],
  ["not_required_right_now", null, false, "stop", true],
  ["already_using_a_tool", null, false, "stop", true],
  ["wrong_contact", null, true, "stop", false],
  ["connected_to_different_contact", null, true, "stop", false],
  ["left_company", null, false, "stop", true],
  ["out_of_office", null, false, "stop", true],
  ["other", null, true, "continue", false],
];

describe("decideReplyType for every default type", () => {
  it("covers each default type once", () => {
    expect(SEEDED.map(([key]) => key)).toEqual(DEFAULT_REPLY_TYPES.map((d) => d.key));
  });

  for (const [key, hold, wantsDraft, followUps, settles] of SEEDED) {
    it(`${key}: hold ${hold ?? "none"}, draft ${wantsDraft}, follow-ups ${followUps}`, () => {
      const d = DEFAULT_REPLY_TYPES.find((t) => t.key === key)!;
      const decision = decideReplyType({ ...d, systemRole: d.systemRole ?? null }, facts);
      expect(decision).toEqual({ hold, wantsDraft, followUps });
      expect(settlesAfterAiPick("action_required", decision, false)).toBe(settles);
    });
  }

  it("covers the two system roles with the keys that drove them", () => {
    expect(DEFAULT_REPLY_TYPES.filter((d) => d.systemRole).map((d) => [d.key, d.systemRole])).toEqual([
      ["customer", "customer"],
      ["do_not_contact", "stop_request"],
    ]);
    expect(DEFAULT_REPLY_TYPES.find((d) => d.systemRole === "stop_request")?.rules).toEqual({ replyDraft: false, followUps: "stop" });
  });
});

describe("decideReplyType", () => {
  it("holds an AI pick of the stop request type, whatever the confidence", () => {
    const stop = type({ replyDraft: false, followUps: "stop" }, { systemRole: "stop_request", groupKey: "not_interested" });
    expect(decideReplyType(stop, { ...facts, confidence: 1 }).hold).toBe("stop_request");
    expect(decideReplyType(stop, { ...facts, confidence: 0.1 }).hold).toBe("stop_request");
  });

  it("holds an AI pick under the floor, and applies one at the floor", () => {
    expect(AI_PICK_CONFIDENCE_FLOOR).toBe(0.85);
    expect(decideReplyType(type(), { ...facts, confidence: 0.8499 }).hold).toBe("low_confidence");
    expect(decideReplyType(type(), { ...facts, confidence: 0.85 }).hold).toBeNull();
  });

  it("holds an AI pick that moves a locked customer out of the group, and no pick inside it", () => {
    const locked = { ...facts, locked: true, currentType: { groupKey: "customer" } };
    expect(decideReplyType(type(), locked).hold).toBe("protected_customer");
    expect(decideReplyType(type(), { ...locked, confidence: 0.1 }).hold).toBe("protected_customer");
    expect(decideReplyType(type({}, { groupKey: "customer" }), locked).hold).toBeNull();
  });

  it("applies every other AI pick at once, whatever type it replaces", () => {
    for (const currentType of [null, { groupKey: "interested" }, { groupKey: "not_interested" }, { groupKey: "other" }]) {
      expect(decideReplyType(type(), { ...facts, currentType }).hold).toBeNull();
    }
    expect(decideReplyType(type({ replyDraft: false, followUps: "stop" }, { systemRole: "customer", groupKey: "customer" }), facts).hold).toBeNull();
  });

  it("applies a pick the reply's own words read as a stop: the stop review holds it, not the pick", () => {
    expect(decideReplyType(type(), { ...facts, stopRequested: true })).toMatchObject({ hold: null, wantsDraft: false });
  });

  it("never holds a person's pick", () => {
    const person = { ...facts, confidence: null, locked: true, currentType: { groupKey: "customer" } };
    expect(decideReplyType(type(), person).hold).toBeNull();
    expect(decideReplyType(type({}, { systemRole: "stop_request" }), person).hold).toBeNull();
  });

  it("writes no draft for a stop request, whatever the type says", () => {
    expect(decideReplyType(type({ replyDraft: true }), facts).wantsDraft).toBe(true);
    expect(decideReplyType(type({ replyDraft: true }), { ...facts, stopRequested: true }).wantsDraft).toBe(false);
    expect(decideReplyType(type({ replyDraft: false }), facts).wantsDraft).toBe(false);
  });

  it("applies follow-ups only to an email reply of a campaign in ai_drafts mode whose person is not a contact", () => {
    expect(decideReplyType(type({ followUps: "continue" }), facts).followUps).toBe("continue");
    expect(decideReplyType(type({ followUps: "stop" }), facts).followUps).toBe("stop");
    expect(decideReplyType(type(), { ...facts, isContact: true }).followUps).toBe("not_applicable");
    expect(decideReplyType(type(), { ...facts, campaignMode: "handoff" }).followUps).toBe("not_applicable");
    expect(decideReplyType(type(), { ...facts, campaignMode: null }).followUps).toBe("not_applicable");
    expect(decideReplyType(type(), { ...facts, channel: "linkedin" }).followUps).toBe("not_applicable");
  });

  it("stops follow-ups for a reply that asked to stop, whatever the type says", () => {
    expect(decideReplyType(type({ followUps: "continue" }), { ...facts, stopRequested: true }).followUps).toBe("stop");
    expect(decideReplyType(type({ followUps: "continue" }), { ...facts, stopRequested: true, confidence: null }).followUps).toBe("stop");
    expect(decideReplyType(type({ followUps: "continue" }), { ...facts, stopRequested: true, isContact: true }).followUps).toBe("not_applicable");
  });
});

describe("typeChangeOutcome", () => {
  const outcomeFacts = { ...facts } as Omit<ReplyTypeFacts, "confidence">;
  const notNow = type({ replyDraft: false, followUps: "stop" }, { name: "Not now", groupKey: "not_interested" });
  const askedToStop = type({ replyDraft: false, followUps: "stop" }, { name: "Asked to stop", groupKey: "not_interested", systemRole: "stop_request" });

  it("says a draft is written and follow-ups keep going for a type that wants both", () => {
    expect(typeChangeOutcome(notNow, type(), outcomeFacts)).toEqual({
      replyDraft: "Reply draft: the AI writes a new one.",
      followUps: "Follow-ups: keep going.",
      contact: "Contact: unchanged.",
    });
  });

  it("names the type's rule when it writes no draft and stops follow-ups", () => {
    expect(typeChangeOutcome(type(), notNow, outcomeFacts)).toEqual({
      replyDraft: "Reply draft: none. Not now is set to not write one.",
      followUps: "Follow-ups: stop. Not now is set to stop follow-ups.",
      contact: "Contact: unchanged.",
    });
    expect(typeChangeOutcome(askedToStop, notNow, outcomeFacts).followUps).toBe("Follow-ups: stay stopped.");
  });

  it("never marks do not contact, even for the stop request type", () => {
    expect(typeChangeOutcome(type(), askedToStop, { ...outcomeFacts, stopRequested: true })).toEqual({
      replyDraft: "Reply draft: none, because they asked to stop.",
      followUps: "Follow-ups: stop, because they asked to stop.",
      contact: "Contact: unchanged until you choose Stop contacting.",
    });
  });

  it("stops follow-ups for a reply that asked to stop, even on a type that keeps them going", () => {
    expect(typeChangeOutcome(notNow, type(), { ...outcomeFacts, stopRequested: true })).toEqual({
      replyDraft: "Reply draft: none, because they asked to stop.",
      followUps: "Follow-ups: stop, because they asked to stop.",
      contact: "Contact: unchanged.",
    });
  });

  it("says a change off the thread writes no draft now, and keeps the other draft lines", () => {
    expect(typeChangeOutcome(notNow, type(), outcomeFacts, "off_thread")).toEqual({
      replyDraft: "Reply draft: none written now. Write a draft from the reply when you need one.",
      followUps: "Follow-ups: keep going.",
      contact: "Contact: unchanged.",
    });
    expect(typeChangeOutcome(notNow, type(), outcomeFacts, "correct").replyDraft).toBe("Reply draft: the AI writes a new one.");
    expect(typeChangeOutcome(type(), notNow, outcomeFacts, "off_thread").replyDraft).toBe("Reply draft: none. Not now is set to not write one.");
    expect(typeChangeOutcome(notNow, type(), { ...outcomeFacts, stopRequested: true }, "off_thread").replyDraft).toBe("Reply draft: none, because they asked to stop.");
  });

  it("says when follow-ups do not apply", () => {
    expect(typeChangeOutcome(null, type(), { ...outcomeFacts, isContact: true }).followUps).toBe("Follow-ups: none, because the person is a contact.");
    expect(typeChangeOutcome(null, type(), { ...outcomeFacts, campaignMode: "handoff" }).followUps).toBe("Follow-ups: none for this conversation.");
    expect(typeChangeOutcome(null, type(), { ...outcomeFacts, campaignMode: "paused" }).followUps).toBe("Follow-ups: none while the campaign is paused.");
    expect(typeChangeOutcome(null, type(), { ...outcomeFacts, campaignMode: "not_started" }).followUps).toBe("Follow-ups: none until the campaign starts.");
    expect(typeChangeOutcome(null, type(), { ...outcomeFacts, campaignMode: "archived" }).followUps).toBe("Follow-ups: none, because the campaign is archived.");
  });
});

describe("holdReasonOf", () => {
  it("reads the three hold reasons and nothing else", () => {
    for (const reason of ["protected_customer", "stop_request", "low_confidence"]) expect(holdReasonOf(reason)).toBe(reason);
    for (const legacy of ["protected_stage", "requires_review", "customer_requires_review", "review_other", "", 3, null, undefined, {}]) expect(holdReasonOf(legacy)).toBeNull();
  });
});
