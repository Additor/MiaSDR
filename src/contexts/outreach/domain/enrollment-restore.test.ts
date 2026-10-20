import { describe, expect, it } from "vitest";
import { RESTORE_REFUSAL_TEXT, decideRestore, restoredProgress, type RestoreFacts, type RestoreRefusal } from "./enrollment-restore";

const now = new Date("2026-10-14T10:00:00Z");
const facts = (over: Partial<RestoreFacts> = {}): RestoreFacts => ({
  status: "removed",
  channel: "linkedin",
  currentStep: 0,
  totalSteps: 3,
  connectionState: "none",
  campaignStatus: "active",
  campaignArchived: false,
  replied: false,
  doNotContact: false,
  suppressed: false,
  contact: false,
  activeElsewhere: null,
  ...over,
});

describe("decideRestore", () => {
  it("puts a lead that never sent anything back to pending", () => {
    expect(decideRestore(facts(), now)).toEqual({ ok: true, status: "pending", nextSendAt: null });
    expect(decideRestore(facts({ channel: "email", connectionState: null }), now)).toEqual({ ok: true, status: "pending", nextSendAt: null });
  });

  it("restores progress as active, never as pending", () => {
    // LinkedIn: invitation out, waiting for the answer.
    expect(decideRestore(facts({ currentStep: 1, connectionState: "request_sent" }), now)).toEqual({ ok: true, status: "active", nextSendAt: null });
    // LinkedIn: accepted while removed, a message is left.
    expect(decideRestore(facts({ currentStep: 1, connectionState: "connected" }), now)).toEqual({ ok: true, status: "active", nextSendAt: now });
    // Email: a follow-up is left.
    expect(decideRestore(facts({ channel: "email", connectionState: null, currentStep: 1 }), now)).toEqual({ ok: true, status: "active", nextSendAt: now });
  });

  it("refuses when every step already went out", () => {
    expect(decideRestore(facts({ currentStep: 3, connectionState: "connected" }), now)).toEqual({ ok: false, reason: "nothing_left" });
    expect(decideRestore(facts({ channel: "email", connectionState: null, currentStep: 3 }), now)).toEqual({ ok: false, reason: "nothing_left" });
  });

  it("still restores an invitation-only lead whose invitation waits for the answer", () => {
    expect(decideRestore(facts({ totalSteps: 1, currentStep: 1, connectionState: "request_sent" }), now)).toMatchObject({ ok: true, status: "active" });
  });

  it.each<[string, Partial<RestoreFacts>, RestoreRefusal]>([
    ["any other status", { status: "pending" }, "not_removed"],
    ["a replied lead", { status: "replied" }, "not_removed"],
    ["a completed campaign", { campaignStatus: "completed" }, "campaign_closed"],
    ["an archived campaign", { campaignArchived: true }, "campaign_closed"],
    ["a person who replied", { replied: true }, "replied"],
    ["do not contact", { doNotContact: true }, "do_not_contact"],
    ["a suppressed address", { suppressed: true, channel: "email", connectionState: null }, "suppressed"],
    ["a contact", { contact: true }, "contact"],
    ["activity elsewhere", { activeElsewhere: "Other campaign" }, "active_elsewhere"],
  ])("refuses %s", (_name, over, reason) => {
    expect(decideRestore(facts(over), now)).toEqual({ ok: false, reason });
    expect(RESTORE_REFUSAL_TEXT[reason]).not.toBe("");
  });

  it("names the first applicable reason: a reply wins over do not contact", () => {
    expect(decideRestore(facts({ replied: true, doNotContact: true, activeElsewhere: "x" }), now)).toEqual({ ok: false, reason: "replied" });
  });

  it("puts a contact after do not contact and suppression, before activity elsewhere", () => {
    expect(decideRestore(facts({ contact: true, doNotContact: true }), now)).toEqual({ ok: false, reason: "do_not_contact" });
    expect(decideRestore(facts({ contact: true, suppressed: true, channel: "email", connectionState: null }), now)).toEqual({ ok: false, reason: "suppressed" });
    expect(decideRestore(facts({ contact: true, activeElsewhere: "x" }), now)).toEqual({ ok: false, reason: "contact" });
  });

  it("restores into a paused or draft campaign", () => {
    expect(decideRestore(facts({ campaignStatus: "paused" }), now).ok).toBe(true);
    expect(decideRestore(facts({ campaignStatus: "draft" }), now).ok).toBe(true);
  });
});

describe("restoredProgress", () => {
  it("takes the largest of the stored step, the last send and the connection", () => {
    expect(restoredProgress({ channel: "linkedin", currentStep: 0, lastSentStep: 1, connectionState: "request_sent" })).toBe(1);
    expect(restoredProgress({ channel: "linkedin", currentStep: 1, lastSentStep: 2, connectionState: "connected" })).toBe(2);
    expect(restoredProgress({ channel: "linkedin", currentStep: 2, lastSentStep: 0, connectionState: "none" })).toBe(2);
    expect(restoredProgress({ channel: "email", currentStep: 0, lastSentStep: 1, connectionState: null })).toBe(1);
  });

  it("reads a LinkedIn connection beyond none as the invitation done, and never for email", () => {
    expect(restoredProgress({ channel: "linkedin", currentStep: 0, lastSentStep: 0, connectionState: "connected" })).toBe(1);
    expect(restoredProgress({ channel: "linkedin", currentStep: 0, lastSentStep: 0, connectionState: "none" })).toBe(0);
    expect(restoredProgress({ channel: "email", currentStep: 0, lastSentStep: 0, connectionState: "connected" })).toBe(0);
  });
});

describe("decideRestore timing", () => {
  const lastSentAt = new Date("2026-10-14T09:50:00Z");

  it("waits the next step's days after the last send", () => {
    expect(decideRestore(facts({ currentStep: 1, connectionState: "connected", lastSentAt, nextWaitDays: 2 }), now)).toEqual({ ok: true, status: "active", nextSendAt: new Date("2026-10-16T09:50:00Z") });
    expect(decideRestore(facts({ channel: "email", connectionState: null, currentStep: 1, lastSentAt, nextWaitDays: 3 }), now)).toEqual({ ok: true, status: "active", nextSendAt: new Date("2026-10-17T09:50:00Z") });
  });

  it("sends now when the wait has passed or the step has no wait", () => {
    expect(decideRestore(facts({ currentStep: 1, connectionState: "connected", lastSentAt: new Date("2026-10-01T00:00:00Z"), nextWaitDays: 2 }), now)).toEqual({ ok: true, status: "active", nextSendAt: now });
    expect(decideRestore(facts({ currentStep: 1, connectionState: "connected", lastSentAt, nextWaitDays: 0 }), now)).toEqual({ ok: true, status: "active", nextSendAt: now });
  });
});
