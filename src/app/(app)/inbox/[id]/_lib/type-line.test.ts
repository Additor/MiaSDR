import { describe, expect, it } from "vitest";
import { decisionKey, decisionView, holdText, latestAiPick, latestPick, noDraftReason, offersLooksRight, pickBadge, rulesSummary, typeDecision, undoMessage, type PickFacts } from "./type-line";

const pick = (over: Partial<PickFacts> = {}): PickFacts => ({
  id: "p1",
  status: "auto_applied",
  provider: "fake",
  latest: true,
  current: true,
  acknowledged: false,
  proposed: { groupKey: "interested", name: "Demo request" },
  applied: { groupKey: "interested", name: "Demo request" },
  appliedReplyTypeId: "t-demo",
  rules: { checkMode: "after" },
  proposedSystemRole: null,
  proposedActive: true,
  holdReason: null,
  stopRequested: false,
  confidence: 0.9,
  reasoning: "Asks for a demo.",
  error: null,
  ...over,
});
const email = { doNotContact: false, suppressed: false, channel: "email" };
const demo = { groupKey: "interested", replyTypeId: "t-demo" };

describe("typeDecision", () => {
  it("asks for Looks right on an applied pick nobody looked at", () => {
    expect(typeDecision(pick(), email, demo)?.kind).toBe("looks_right");
    expect(typeDecision(pick({ acknowledged: true }), email, demo)).toBeNull();
    // A type that skips the check asks nothing.
    expect(typeDecision(pick({ rules: { checkMode: "skip" } }), email, demo)).toBeNull();
    // A person changed the type since: the pick no longer describes the record.
    expect(typeDecision(pick(), email, { groupKey: "interested", replyTypeId: "t-meeting" })).toBeNull();
    // Another type with the same name in the same group is still another type.
    expect(typeDecision(pick({ applied: { groupKey: "interested", name: "Demo request" } }), email, { groupKey: "interested", replyTypeId: "t-demo-2" })).toBeNull();
  });

  it("holds a proposed pick only while it is current", () => {
    expect(typeDecision(pick({ status: "proposed", holdReason: "low_confidence" }), email, demo)?.kind).toBe("held");
    expect(typeDecision(pick({ status: "proposed", current: false }), email, demo)).toBeNull();
  });

  it("offers no Accept for a held pick whose type an admin archived since", () => {
    expect(typeDecision(pick({ status: "proposed", proposedActive: false, holdReason: "requires_review" }), email, demo)?.kind).toBe("archived");
    expect(typeDecision(pick({ status: "proposed", proposedActive: false, current: false }), email, demo)).toBeNull();
  });

  it("puts a stop request first, and drops it once contact stopped", () => {
    const stop = pick({ status: "proposed", proposedSystemRole: "stop_request", stopRequested: true });
    expect(typeDecision(stop, email, demo)?.kind).toBe("stop");
    expect(typeDecision(stop, { ...email, doNotContact: true }, demo)).toBeNull();
    expect(typeDecision(stop, { ...email, suppressed: true }, demo)).toBeNull();
    // Suppression covers the email address only, so a LinkedIn thread still asks.
    expect(typeDecision(stop, { ...email, suppressed: true, channel: "linkedin" }, demo)?.kind).toBe("stop");
  });

  it("asks nothing for a pick of an older reply or a person's decision", () => {
    expect(typeDecision(pick({ latest: false }), email, demo)).toBeNull();
    expect(typeDecision(pick({ status: "overridden", stopRequested: true }), email, demo)).toBeNull();
    expect(typeDecision(undefined, email, demo)).toBeNull();
  });
});

describe("latestPick", () => {
  it("takes the newest pick of the latest reply and passes over a stale one", () => {
    const entries = [pick({ id: "stale", status: "stale" }), pick({ id: "applied" }), pick({ id: "old", latest: false })];
    expect(latestPick(entries)?.id).toBe("applied");
    expect(latestPick([pick({ id: "stale", status: "stale" })])?.id).toBe("stale");
  });

  it("leaves a person's pick out of the AI's reading", () => {
    expect(latestAiPick([pick({ id: "human", provider: "human", status: "overridden" }), pick({ id: "ai", status: "overridden" })])?.id).toBe("ai");
  });
});

describe("texts", () => {
  it("summarises the rules", () => {
    expect(rulesSummary({ replyDraft: true, followUps: "continue" })).toBe("Draft · Follow-ups keep going");
    expect(rulesSummary({ replyDraft: false, followUps: "stop" })).toBe("No draft · Follow-ups stop");
  });

  it("names the type that writes no draft", () => {
    expect(noDraftReason({ name: "Not now", rules: { replyDraft: false } })).toBe("No draft: Not now replies get none.");
    expect(noDraftReason({ name: "Demo request", rules: { replyDraft: true } })).toBeNull();
    expect(noDraftReason(null)).toBeNull();
  });

  it("says what Undo retired", () => {
    expect(undoMessage({ draftsRetired: 0, runEnded: false })).toBe("AI pick undone. Nothing else changed.");
    expect(undoMessage({ draftsRetired: 1, runEnded: false })).toBe("AI pick undone. It retired 1 draft.");
    expect(undoMessage({ draftsRetired: 2, runEnded: true, draftJobCancelled: true })).toBe("AI pick undone. It retired 2 drafts, cancelled the draft the AI was about to write and ended follow-ups.");
  });
});

describe("holdText", () => {
  it("says why a held pick waits, and falls back for a reason stored before 0003 or none", () => {
    expect(holdText("low_confidence")).toBe("The AI's confidence is under the confidence floor.");
    expect(holdText("protected_customer")).toBe("The person is locked as Existing customer. Accept takes them out of it.");
    for (const legacy of ["protected_stage", "customer_requires_review", "review_other", "anything", null, undefined]) {
      expect(holdText(legacy)).toBe("It waits for you.");
    }
  });
});

describe("decisionView", () => {
  const held = decisionKey({ kind: "held", pickId: "p1" });

  it("shows a decision nobody answered", () => {
    expect(decisionView(held, null)).toEqual({ showDecision: true, done: null });
    expect(decisionView(null, null)).toEqual({ showDecision: false, done: null });
  });

  it("hides the answered decision before the refresh lands, so a second click cannot send it", () => {
    expect(decisionView(held, { key: held!, text: "AI pick accepted." })).toEqual({ showDecision: false, done: "AI pick accepted." });
  });

  it("keeps the done line once the decision is gone", () => {
    expect(decisionView(null, { key: held!, text: "AI pick accepted." })).toEqual({ showDecision: false, done: "AI pick accepted." });
  });

  it("clears the done line when a new decision arrives", () => {
    const next = decisionKey({ kind: "looks_right", pickId: "p2" });
    expect(decisionView(next, { key: held!, text: "AI pick accepted." })).toEqual({ showDecision: true, done: null });
  });
});

describe("pickBadge", () => {
  const entry = { status: "auto_applied", acknowledged: false, current: true, rules: { checkMode: "after" as const } };

  it("marks an applied pick Not checked only while it waits for Looks right", () => {
    expect(pickBadge(entry)).toBe("Not checked");
    expect(pickBadge({ ...entry, rules: null })).toBe("Not checked");
    expect(pickBadge({ ...entry, rules: { checkMode: "skip" } })).toBeNull();
    expect(pickBadge({ ...entry, rules: { checkMode: "before" } })).toBeNull();
    expect(pickBadge({ ...entry, acknowledged: true })).toBeNull();
    // A later decision moved the record on: the pick no longer waits.
    expect(pickBadge({ ...entry, current: false })).toBeNull();
  });

  it("marks a held pick and a failed one", () => {
    expect(pickBadge({ ...entry, status: "proposed" })).toBe("Held for a check");
    expect(pickBadge({ ...entry, status: "failed" })).toBe("Failed");
    expect(pickBadge({ ...entry, status: "accepted" })).toBeNull();
  });
});

describe("offersLooksRight", () => {
  const entry = { status: "auto_applied", acknowledged: false, current: true, rules: { checkMode: "after" as const }, canAcknowledge: true };

  it("offers Looks right on a pick marked Not checked", () => {
    expect(offersLooksRight(entry)).toBe(true);
  });

  it("offers it on no pick without that badge, even when the server would take it", () => {
    expect(offersLooksRight({ ...entry, rules: { checkMode: "skip" } })).toBe(false);
    expect(offersLooksRight({ ...entry, current: false })).toBe(false);
    expect(offersLooksRight({ ...entry, status: "failed" })).toBe(false);
    expect(offersLooksRight({ ...entry, canAcknowledge: false })).toBe(false);
  });
});
