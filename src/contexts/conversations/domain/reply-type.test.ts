import { describe, expect, it } from "vitest";
import { DEFAULT_REPLY_TYPES } from "./default-reply-types";
import {
  decideReplyType,
  holdReasonOf,
  DEFAULT_TYPE_RULES,
  STOP_REQUEST_RULES,
  typeChangeOutcome,
  validateTypeRules,
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
  floor: 0.85,
  locked: false,
  currentType: null,
};

const type = (rules: Partial<TypeRules> = {}, over: Partial<ReplyType> = {}): ReplyType => ({
  id: "t1",
  key: "demo_request",
  name: "Demo request",
  groupKey: "interested",
  systemRole: null,
  rules: { ...DEFAULT_TYPE_RULES, ...rules },
  ...over,
});

type SeededDecision = [key: string, hold: "requires_review" | null, needsLooksRight: boolean, wantsDraft: boolean, followUps: "continue" | "stop", settles: boolean];

/**
 * What an AI pick of each default type decides, with `facts` above. The values are written out so a change to the
 * seeded rules or to `decideReplyType` shows up here. `settles` is `settlesAfterAiPick` from `action_required`.
 */
const SEEDED: readonly SeededDecision[] = [
  ["information_requested", null, true, true, "continue", false],
  ["case_study", null, true, true, "continue", false],
  ["demo_request", null, true, true, "continue", false],
  ["meeting_requested", null, true, true, "continue", false],
  ["meeting_no_show", null, true, true, "continue", false],
  ["meeting_done", null, true, true, "continue", false],
  ["trial_requested", null, true, true, "continue", false],
  ["trial_user", null, true, true, "continue", false],
  ["customer", "requires_review", false, true, "stop", false],
  ["do_not_contact", "requires_review", false, false, "stop", false],
  ["not_required_right_now", null, false, false, "stop", true],
  ["already_using_a_tool", null, false, false, "stop", true],
  ["wrong_contact", "requires_review", false, true, "stop", false],
  ["connected_to_different_contact", "requires_review", false, true, "stop", false],
  ["left_company", "requires_review", false, false, "stop", false],
  ["out_of_office", "requires_review", false, false, "stop", false],
  ["other", "requires_review", false, true, "continue", false],
];

describe("decideReplyType for every default type", () => {
  it("covers each default type once", () => {
    expect(SEEDED.map(([key]) => key)).toEqual(DEFAULT_REPLY_TYPES.map((d) => d.key));
  });

  for (const [key, hold, needsLooksRight, wantsDraft, followUps, settles] of SEEDED) {
    it(`${key}: hold ${hold ?? "none"}, draft ${wantsDraft}, follow-ups ${followUps}`, () => {
      const d = DEFAULT_REPLY_TYPES.find((t) => t.key === key)!;
      const decision = decideReplyType(d, facts);
      expect(decision).toEqual({ hold, needsLooksRight, wantsDraft, followUps });
      expect(settlesAfterAiPick("action_required", decision, false)).toBe(settles);
    });
  }

  it("covers the two system roles with the keys that drove them", () => {
    expect(DEFAULT_REPLY_TYPES.filter((d) => d.systemRole).map((d) => [d.key, d.systemRole])).toEqual([
      ["customer", "customer"],
      ["do_not_contact", "stop_request"],
    ]);
    expect(DEFAULT_REPLY_TYPES.find((d) => d.systemRole === "stop_request")?.rules).toEqual(STOP_REQUEST_RULES);
  });
});

describe("decideReplyType", () => {
  it("holds an AI pick for the customer lock, then for Check before, then below the floor", () => {
    const locked = { ...facts, locked: true, currentType: { groupKey: "customer" } };
    expect(decideReplyType(type({ checkMode: "before" }), { ...locked, confidence: 0.1 }).hold).toBe("protected_customer");
    expect(decideReplyType(type({}, { groupKey: "customer" }), locked).hold).toBeNull();
    expect(decideReplyType(type({ checkMode: "before" }), { ...facts, confidence: 0.1 }).hold).toBe("requires_review");
    expect(decideReplyType(type({ checkMode: "skip" }), { ...facts, confidence: 0.84 }).hold).toBe("low_confidence");
    expect(decideReplyType(type({ checkMode: "skip" }), { ...facts, confidence: 0.85 }).hold).toBeNull();
  });

  it("applies a confident AI pick of a type checked after, whatever type it replaces", () => {
    // Progress belongs to Deal stage: no pick waits to protect the type it replaces. A team that wants a person to confirm
    // a move into a type sets that type's Check to before.
    const meetingDone = type({ checkMode: "after" }, { key: "meeting_done", name: "Meeting done" });
    for (const currentType of [null, { groupKey: "interested" }, { groupKey: "not_interested" }, { groupKey: "other" }]) {
      expect(decideReplyType(meetingDone, { ...facts, currentType })).toMatchObject({ hold: null, needsLooksRight: true });
    }
    expect(decideReplyType({ ...meetingDone, rules: { ...meetingDone.rules, checkMode: "before" } }, facts).hold).toBe("requires_review");
  });

  it("never holds a person's pick, and asks Looks right only of an applied AI pick of a type checked after", () => {
    const person = { ...facts, confidence: null, locked: true, currentType: { groupKey: "customer" } };
    expect(decideReplyType(type({ checkMode: "before" }), person)).toMatchObject({ hold: null, needsLooksRight: false });
    expect(decideReplyType(type({ checkMode: "after" }), facts).needsLooksRight).toBe(true);
    expect(decideReplyType(type({ checkMode: "after" }), { ...facts, confidence: 0.5 }).needsLooksRight).toBe(false);
    expect(decideReplyType(type({ checkMode: "skip" }), facts).needsLooksRight).toBe(false);
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

describe("validateTypeRules", () => {
  it("accepts any rules for a type without a role or with the customer role", () => {
    const rules: TypeRules = { checkMode: "skip", replyDraft: false, followUps: "continue" };
    expect(validateTypeRules({ systemRole: null }, rules)).toEqual(rules);
    expect(validateTypeRules({ systemRole: "customer" }, rules)).toEqual(rules);
  });

  it("keeps the stop request rules", () => {
    expect(validateTypeRules({ systemRole: "stop_request" }, { ...STOP_REQUEST_RULES })).toEqual(STOP_REQUEST_RULES);
    expect(() => validateTypeRules({ systemRole: "stop_request" }, { ...STOP_REQUEST_RULES, checkMode: "after" })).toThrow(/checked before/);
    expect(() => validateTypeRules({ systemRole: "stop_request" }, { ...STOP_REQUEST_RULES, replyDraft: true })).toThrow(/never gets a reply draft/);
    expect(() => validateTypeRules({ systemRole: "stop_request" }, { ...STOP_REQUEST_RULES, followUps: "continue" })).toThrow(/stops follow-ups/);
  });

  it("refuses values outside the rule sets", () => {
    expect(() => validateTypeRules({ systemRole: null }, { ...DEFAULT_TYPE_RULES, checkMode: "later" as never })).toThrow(/Check/);
    expect(() => validateTypeRules({ systemRole: null }, { ...DEFAULT_TYPE_RULES, followUps: "pause" as never })).toThrow(/Follow-ups/);
    expect(() => validateTypeRules({ systemRole: null }, { ...DEFAULT_TYPE_RULES, replyDraft: "yes" as never })).toThrow(/Reply draft/);
  });
});

describe("typeChangeOutcome", () => {
  const outcomeFacts = { ...facts } as Omit<ReplyTypeFacts, "confidence">;
  const notNow = type({ checkMode: "skip", replyDraft: false, followUps: "stop" }, { name: "Not now", groupKey: "not_interested" });
  const askedToStop = type(STOP_REQUEST_RULES, { name: "Asked to stop", groupKey: "not_interested", systemRole: "stop_request" });

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

  it("says when follow-ups do not apply", () => {
    expect(typeChangeOutcome(null, type(), { ...outcomeFacts, isContact: true }).followUps).toBe("Follow-ups: none, because the person is a contact.");
    expect(typeChangeOutcome(null, type(), { ...outcomeFacts, campaignMode: "handoff" }).followUps).toBe("Follow-ups: none for this conversation.");
  });
});

describe("holdReasonOf", () => {
  it("reads the three hold reasons and nothing else", () => {
    for (const reason of ["protected_customer", "requires_review", "low_confidence"]) expect(holdReasonOf(reason)).toBe(reason);
    for (const legacy of ["protected_stage", "customer_requires_review", "review_other", "", 3, null, undefined, {}]) expect(holdReasonOf(legacy)).toBeNull();
  });
});
