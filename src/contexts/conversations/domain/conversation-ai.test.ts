import { describe, expect, it } from "vitest";
import { decideApplication, type PolicyInput } from "./classification-policy";
import { normalizeSubject } from "./subject";
import { needsReply, replySubject } from "./reply-policy";
import { detectsStopRequest, stripQuoted } from "./stop-request";

const base: PolicyInput = {
  proposal: { groupKey: "interested", replyTypeKey: "demo_request", reviewRequired: false, stageRank: 1, confidence: 0.9 },
  current: { groupKey: null, stageRank: null, replyTypeLocked: false },
  settings: { autoApplyConfidence: 0.85, reviewOther: true, customerRequiresReview: true },
};
const withProposal = (p: Partial<PolicyInput["proposal"]>, c: Partial<PolicyInput["current"]> = {}, s: Partial<PolicyInput["settings"]> = {}): PolicyInput => ({
  proposal: { ...base.proposal, ...p },
  current: { ...base.current, ...c },
  settings: { ...base.settings, ...s },
});

describe("classification policy", () => {
  it("applies at or above the threshold and holds below it", () => {
    expect(decideApplication(withProposal({ confidence: 0.85 }))).toEqual({ action: "auto_apply" });
    expect(decideApplication(withProposal({ confidence: 0.84 }))).toEqual({ action: "hold", reason: "low_confidence" });
  });

  it("holds customer, review-required subcategories and the other category", () => {
    expect(decideApplication(withProposal({ groupKey: "customer", replyTypeKey: "customer" }))).toEqual({ action: "hold", reason: "requires_review" });
    expect(decideApplication(withProposal({ groupKey: "customer", replyTypeKey: "customer" }, {}, { customerRequiresReview: false }))).toEqual({ action: "auto_apply" });
    expect(decideApplication(withProposal({ reviewRequired: true }))).toEqual({ action: "hold", reason: "requires_review" });
    expect(decideApplication(withProposal({ groupKey: "other", replyTypeKey: "other", stageRank: null }))).toEqual({ action: "hold", reason: "requires_review" });
    expect(decideApplication(withProposal({ groupKey: "other", replyTypeKey: "other", stageRank: null }, {}, { reviewOther: false }))).toEqual({ action: "auto_apply" });
  });

  it("protects a locked customer and a higher funnel stage", () => {
    expect(decideApplication(withProposal({}, { groupKey: "customer", replyTypeLocked: true }))).toEqual({ action: "hold", reason: "protected_customer" });
    expect(decideApplication(withProposal({ stageRank: 1 }, { groupKey: "interested", stageRank: 3 }))).toEqual({ action: "hold", reason: "protected_stage" });
    expect(decideApplication(withProposal({ groupKey: "not_interested", replyTypeKey: "not_required_right_now", stageRank: null }, { stageRank: 3 }))).toEqual({ action: "hold", reason: "protected_stage" });
    expect(decideApplication(withProposal({ stageRank: 3 }, { stageRank: 3 }))).toEqual({ action: "auto_apply" });
  });

  it("lets do not contact through a stage", () => {
    expect(decideApplication(withProposal({ groupKey: "not_interested", replyTypeKey: "do_not_contact", stageRank: null, confidence: 0.99 }, { stageRank: 3 }))).toEqual({ action: "auto_apply" });
  });
});

describe("stop requests", () => {
  it("finds an explicit request in the sender's own words", () => {
    expect(detectsStopRequest("Please unsubscribe me from this list.")).toBe(true);
    expect(detectsStopRequest("Stop emailing me.")).toBe(true);
    expect(detectsStopRequest("Do not contact me again")).toBe(true);
  });
  it("ignores our own footer quoted back in a reply", () => {
    const reply = "Sounds good, call me Tuesday.\n\nOn Tue, Oct 13, 2026 at 9:00 AM Rep <rep@x.test> wrote:\n> hi\n> Don't want to hear from us again? Unsubscribe: https://x";
    expect(detectsStopRequest(reply)).toBe(false);
    expect(stripQuoted("> quoted\nown line")).toBe("own line");
  });
});

describe("reply policy", () => {
  it("drafts for interest and not for stop or out-of-office outcomes", () => {
    expect(needsReply("interested", "demo_request")).toBe(true);
    expect(needsReply("customer", "customer")).toBe(true);
    expect(needsReply("not_interested", "not_required_right_now")).toBe(false);
    expect(needsReply("other", "out_of_office")).toBe(false);
  });
  it("builds a reply subject without doubling Re:", () => {
    expect(replySubject("Hello")).toBe("Re: Hello");
    expect(replySubject("RE: Hello")).toBe("RE: Hello");
    expect(replySubject(null)).toBe("Re: your message");
  });
});

describe("normalizeSubject", () => {
  it.each([
    ["Hello  world", "Hello world"],
    ["Line1\r\nBcc: x@y.z", "Line1 Bcc: x@y.z"],
    ["a\nb\rc", "a b c"],
    ["a\u2028b\u2029c\u0085d", "a b c d"],
    ["  padded\t ", "padded"],
    ["nul\u0000byte", "nul byte"],
    ["", ""],
    ["x".repeat(300), "x".repeat(200)],
  ])("%j -> %j", (input, expected) => {
    expect(normalizeSubject(input)).toBe(expected);
  });
});
