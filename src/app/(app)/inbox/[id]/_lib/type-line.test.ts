import { describe, expect, it } from "vitest";
import { decisionKey, decisionView, holdText, latestAiPick, latestPick, noDraftReason, pickBadge, rulesSummary, typeDecision, undoMessage, type PickFacts } from "./type-line";

const pick = (over: Partial<PickFacts> = {}): PickFacts => ({
  id: "p1",
  status: "auto_applied",
  provider: "fake",
  latest: true,
  current: true,
  proposed: { groupKey: "interested", name: "Demo request" },
  applied: { groupKey: "interested", name: "Demo request" },
  appliedReplyTypeId: "t-demo",
  proposedSystemRole: null,
  holdReason: null,
  stopRequested: false,
  confidence: 0.9,
  reasoning: "Asks for a demo.",
  error: null,
  ...over,
});
const email = { doNotContact: false, suppressed: false, channel: "email" };
const demo = { groupKey: "interested", replyTypeId: "t-demo", stopReviewOpen: false };
const stopOpen = { ...demo, stopReviewOpen: true };

describe("typeDecision", () => {
  it("asks about a stop request no pick has read, from the reply's own words", () => {
    expect(typeDecision(undefined, email, stopOpen)).toEqual({ kind: "stop", pick: null });
    expect(typeDecision(undefined, { ...email, doNotContact: true }, stopOpen)).toBeNull();
    expect(typeDecision(undefined, email, demo)).toBeNull();
  });

  it("asks nothing of an applied pick", () => {
    expect(typeDecision(pick(), email, demo)).toBeNull();
  });

  it("holds a proposed pick only while it is current", () => {
    expect(typeDecision(pick({ status: "proposed", holdReason: "low_confidence" }), email, demo)?.kind).toBe("held");
    expect(typeDecision(pick({ status: "proposed", current: false }), email, demo)).toBeNull();
    expect(typeDecision(pick({ status: "stale", stopRequested: true, current: false }), email, stopOpen)?.kind).toBe("stop");
  });

  it("puts a stop request first, and drops it once contact stopped", () => {
    const stop = pick({ status: "proposed", proposedSystemRole: "stop_request", stopRequested: true });
    expect(typeDecision(stop, email, stopOpen)?.kind).toBe("stop");
    expect(typeDecision(stop, { ...email, doNotContact: true }, stopOpen)).toBeNull();
    expect(typeDecision(stop, { ...email, suppressed: true }, stopOpen)).toBeNull();
    // Suppression covers the email address only, so a LinkedIn thread still asks.
    expect(typeDecision(stop, { ...email, suppressed: true, channel: "linkedin" }, stopOpen)?.kind).toBe("stop");
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
  it("says why a held pick waits, and falls back for an unknown reason or none", () => {
    expect(holdText("low_confidence")).toBe("The AI's confidence is under the 85% floor.");
    expect(holdText("protected_customer")).toBe("The person is locked as Existing customer. Accept takes them out of it.");
    for (const unknown of ["anything", null, undefined]) {
      expect(holdText(unknown)).toBe("It waits for you.");
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
    const next = decisionKey({ kind: "stop", pickId: "p2" });
    expect(decisionView(next, { key: held!, text: "AI pick accepted." })).toEqual({ showDecision: true, done: null });
  });
});

describe("pickBadge", () => {
  it("marks a held pick and a failed one, and no other", () => {
    expect(pickBadge({ status: "proposed" })).toBe("Held for a check");
    expect(pickBadge({ status: "failed" })).toBe("Failed");
    for (const status of ["auto_applied", "accepted", "overridden", "rejected", "stale"]) expect(pickBadge({ status })).toBeNull();
  });
});
