import { describe, expect, it } from "vitest";
import { decideApplication, type PolicyInput } from "./reply-type-pick-policy";
import { DEFAULT_TYPE_RULES, STOP_REQUEST_RULES } from "./reply-type";
import { normalizeSubject } from "./subject";
import { needsReply, replySubject } from "./reply-policy";
import { detectsStopRequest, stripQuoted } from "./stop-request";

const base: PolicyInput = {
  proposal: { groupKey: "interested", rules: { ...DEFAULT_TYPE_RULES } },
  confidence: 0.9,
  current: { groupKey: null, replyTypeLocked: false },
  floor: 0.85,
};
const pick = (over: Partial<PolicyInput> = {}): PolicyInput => ({ ...base, ...over });

describe("reply type pick policy", () => {
  it("applies at or above the confidence floor and holds below it", () => {
    expect(decideApplication(pick({ confidence: 0.85 }))).toEqual({ action: "auto_apply" });
    expect(decideApplication(pick({ confidence: 0.84 }))).toEqual({ action: "hold", reason: "low_confidence" });
  });

  it("holds a type checked before it applies, whatever the confidence", () => {
    expect(decideApplication(pick({ proposal: { groupKey: "customer", rules: { ...DEFAULT_TYPE_RULES, checkMode: "before" } }, confidence: 1 }))).toEqual({ action: "hold", reason: "requires_review" });
    expect(decideApplication(pick({ proposal: { groupKey: "not_interested", rules: { ...STOP_REQUEST_RULES } }, confidence: 1 }))).toEqual({ action: "hold", reason: "requires_review" });
    expect(decideApplication(pick({ proposal: { groupKey: "other", rules: { ...DEFAULT_TYPE_RULES, checkMode: "skip" } } }))).toEqual({ action: "auto_apply" });
  });

  it("protects a locked customer", () => {
    expect(decideApplication(pick({ current: { groupKey: "customer", replyTypeLocked: true } }))).toEqual({ action: "hold", reason: "protected_customer" });
    expect(decideApplication(pick({ proposal: { groupKey: "customer", rules: { ...DEFAULT_TYPE_RULES } }, current: { groupKey: "customer", replyTypeLocked: true } }))).toEqual({ action: "auto_apply" });
  });

  it("no longer holds a move to a lower position: progress belongs to deal stages", () => {
    expect(decideApplication(pick({ proposal: { groupKey: "not_interested", rules: { ...DEFAULT_TYPE_RULES, checkMode: "skip" } }, current: { groupKey: "interested", replyTypeLocked: false } }))).toEqual({ action: "auto_apply" });
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
