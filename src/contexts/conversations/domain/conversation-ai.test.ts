import { describe, expect, it } from "vitest";
import { stopRequestedBy } from "./reply-type-pick-policy";
import { DEFAULT_TYPE_RULES, STOP_REQUEST_RULES, decideReplyType, type ReplyType, type ReplyTypeFacts } from "./reply-type";
import { normalizeSubject } from "./subject";
import { replySubject } from "./reply-policy";
import { detectsStopRequest, stripQuoted } from "./stop-request";

interface AiPick {
  proposal: Pick<ReplyType, "groupKey" | "rules">;
  confidence: number;
  current: { groupKey: string | null; replyTypeLocked: boolean };
  floor: number;
  stopRequested?: boolean;
}
const base: AiPick = {
  proposal: { groupKey: "interested", rules: { ...DEFAULT_TYPE_RULES } },
  confidence: 0.9,
  current: { groupKey: null, replyTypeLocked: false },
  floor: 0.85,
};
const pick = (over: Partial<AiPick> = {}): AiPick => ({ ...base, ...over });
/** An AI pick as the apply path decides it. Follow-ups are not under test here. */
const decide = ({ proposal, confidence, current, floor, stopRequested = false }: AiPick) => {
  const facts: ReplyTypeFacts = {
    confidence,
    floor,
    locked: current.replyTypeLocked,
    currentType: { id: null, groupKey: current.groupKey, systemRole: null },
    stopRequested,
    isContact: false,
    campaignMode: null,
    channel: null,
  };
  const { hold, wantsDraft } = decideReplyType(proposal, facts);
  return { hold, wantsDraft };
};

describe("reply type pick policy", () => {
  it("applies at or above the confidence floor and holds below it", () => {
    expect(decide(pick({ confidence: 0.85 })).hold).toBeNull();
    expect(decide(pick({ confidence: 0.84 })).hold).toBe("low_confidence");
  });

  it("holds a type checked before it applies, whatever the confidence", () => {
    expect(decide(pick({ proposal: { groupKey: "customer", rules: { ...DEFAULT_TYPE_RULES, checkMode: "before" } }, confidence: 1 })).hold).toBe("requires_review");
    expect(decide(pick({ proposal: { groupKey: "not_interested", rules: { ...STOP_REQUEST_RULES } }, confidence: 1 })).hold).toBe("requires_review");
    expect(decide(pick({ proposal: { groupKey: "other", rules: { ...DEFAULT_TYPE_RULES, checkMode: "skip" } } })).hold).toBeNull();
  });

  it("protects a locked customer", () => {
    expect(decide(pick({ current: { groupKey: "customer", replyTypeLocked: true } })).hold).toBe("protected_customer");
    expect(decide(pick({ proposal: { groupKey: "customer", rules: { ...DEFAULT_TYPE_RULES } }, current: { groupKey: "customer", replyTypeLocked: true } })).hold).toBeNull();
  });

  it("no longer holds a move to a lower position: progress belongs to deal stages", () => {
    expect(decide(pick({ proposal: { groupKey: "not_interested", rules: { ...DEFAULT_TYPE_RULES, checkMode: "skip" } }, current: { groupKey: "interested", replyTypeLocked: false } })).hold).toBeNull();
  });

  it("wants a draft when the type writes one and the reply asks nothing to stop", () => {
    expect(decide(pick())).toEqual({ hold: null, wantsDraft: true });
    expect(decide(pick({ stopRequested: true }))).toEqual({ hold: null, wantsDraft: false });
    expect(decide(pick({ proposal: { groupKey: "interested", rules: { ...DEFAULT_TYPE_RULES, replyDraft: false } } })).wantsDraft).toBe(false);
    expect(decide(pick({ confidence: 0.5 }))).toEqual({ hold: "low_confidence", wantsDraft: true });
  });

  it("reads a stop request from the sender's words or from the stop request type, never from the key", () => {
    expect(stopRequestedBy("Please unsubscribe me.", { systemRole: null })).toBe(true);
    expect(stopRequestedBy("Sounds good.", { systemRole: "stop_request" })).toBe(true);
    expect(stopRequestedBy("Sounds good.", { systemRole: null })).toBe(false);
    expect(stopRequestedBy("Sounds good.", { systemRole: "customer" })).toBe(false);
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
