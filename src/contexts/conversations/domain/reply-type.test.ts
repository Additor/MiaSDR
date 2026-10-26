import { describe, expect, it } from "vitest";
import { isTerminalReplyType, NO_START_KEYS } from "../after-reply/domain/sequences";
import { DEFAULT_REPLY_TYPES } from "./default-reply-types";
import { needsReply } from "./reply-policy";
import {
  decideReplyType,
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

/** The review hold before type rules, with the default settings (review_other and customer_requires_review on). */
const oldReviewHold = (groupKey: string, reviewRequired: boolean) => reviewRequired || groupKey === "customer" || groupKey === "other";

describe("decideReplyType against the rules it replaces, for every default type", () => {
  for (const d of DEFAULT_REPLY_TYPES) {
    it(`${d.key}: same draft, start, stop and settle as the key and group rules`, () => {
      const decision = decideReplyType(d, facts);
      // reply-policy needsReply
      expect(decision.wantsDraft).toBe(needsReply(d.groupKey, d.key));
      // after-reply start rule: NO_START_KEYS plus the not_interested group
      const startBlocked = NO_START_KEYS.includes(d.key) || d.groupKey === "not_interested";
      expect(decision.followUps === "stop").toBe(startBlocked);
      // after-reply interrupt rule. The one intended difference: Out of office follow-ups now stop instead of running on.
      if (d.key === "out_of_office") {
        expect(isTerminalReplyType(d.groupKey, d.key)).toBe(false);
        expect(decision.followUps).toBe("stop");
      } else {
        expect(decision.followUps === "stop").toBe(isTerminalReplyType(d.groupKey, d.key));
      }
      // The review hold of classification-policy. The stop request type is now always checked before it applies
      // (`systemRole: stop_request`), where do_not_contact used to apply on its own.
      if (d.systemRole === "stop_request") expect(decision.hold).toBe("requires_review");
      else expect(decision.hold === "requires_review").toBe(oldReviewHold(d.groupKey, d.key === "customer"));
      // workflow-state settle, for a pick that applied. The old rule settled `action_required` when no draft was wanted
      // and nothing asked to stop.
      if (decision.hold === null) {
        expect(settlesAfterAiPick("action_required", decision, false)).toBe(!needsReply(d.groupKey, d.key));
      }
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
    const locked = { ...facts, locked: true, currentType: { id: "c", groupKey: "customer", systemRole: "customer" as const } };
    expect(decideReplyType(type({ checkMode: "before" }), { ...locked, confidence: 0.1 }).hold).toBe("protected_customer");
    expect(decideReplyType(type({}, { groupKey: "customer" }), locked).hold).toBeNull();
    expect(decideReplyType(type({ checkMode: "before" }), { ...facts, confidence: 0.1 }).hold).toBe("requires_review");
    expect(decideReplyType(type({ checkMode: "skip" }), { ...facts, confidence: 0.84 }).hold).toBe("low_confidence");
    expect(decideReplyType(type({ checkMode: "skip" }), { ...facts, confidence: 0.85 }).hold).toBeNull();
  });

  it("never holds a person's pick, and asks Looks right only of an applied AI pick of a type checked after", () => {
    const person = { ...facts, confidence: null, locked: true, currentType: { id: "c", groupKey: "customer", systemRole: "customer" as const } };
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
      followUps: "Follow-ups: stop. Asked to stop is set to stop follow-ups.",
      contact: "Contact: unchanged until you choose Stop contacting.",
    });
  });

  it("says when follow-ups do not apply", () => {
    expect(typeChangeOutcome(null, type(), { ...outcomeFacts, isContact: true }).followUps).toBe("Follow-ups: none, because the person is a contact.");
    expect(typeChangeOutcome(null, type(), { ...outcomeFacts, campaignMode: "handoff" }).followUps).toBe("Follow-ups: none for this conversation.");
  });
});
