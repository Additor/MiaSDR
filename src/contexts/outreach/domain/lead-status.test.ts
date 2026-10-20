import { describe, expect, it } from "vitest";
import { LEAD_STATE_LABELS, LEAD_STATES, latestContact, leadStatus, type LeadEnrollmentFact } from "./lead-status";

const fact = (id: string, status: string, updated: string, over: Partial<LeadEnrollmentFact> = {}): LeadEnrollmentFact => ({
  id,
  status,
  campaignStatus: "active",
  campaignName: `C-${id}`,
  updatedAt: new Date(updated),
  lastSentAt: null,
  nextSendAt: null,
  currentStep: 0,
  stopReason: null,
  ...over,
});

const stateOf = (enrollments: LeadEnrollmentFact[], hasInbound = false) => leadStatus({ enrollments, lastOutboundAt: null, hasInbound }).state;

describe("leadStatus", () => {
  it("is new without an enrollment, and with removed ones only", () => {
    expect(leadStatus({ enrollments: [], lastOutboundAt: null, hasInbound: false })).toEqual({ state: "new", enrollment: null, otherCampaigns: 0, lastContactAt: null });
    expect(stateOf([fact("a", "removed", "2026-10-01")])).toBe("new");
  });

  it("reads every state from its enrollment", () => {
    expect(stateOf([fact("a", "pending", "2026-10-01")])).toBe("queued");
    expect(stateOf([fact("a", "active", "2026-10-01")])).toBe("in_sequence");
    expect(stateOf([fact("a", "active", "2026-10-01", { campaignStatus: "paused" })])).toBe("paused");
    expect(stateOf([fact("a", "pending", "2026-10-01", { campaignStatus: "paused" })])).toBe("paused");
    expect(stateOf([fact("a", "replied", "2026-10-01")])).toBe("replied");
    expect(stateOf([fact("a", "completed", "2026-10-01")])).toBe("finished");
    for (const status of ["bounced", "suppressed", "failed", "cancelled"]) expect(stateOf([fact("a", status, "2026-10-01")])).toBe("stopped");
  });

  it("counts an inbound message as a reply, with or without an enrollment", () => {
    expect(leadStatus({ enrollments: [], lastOutboundAt: null, hasInbound: true })).toMatchObject({ state: "replied", enrollment: null });
    expect(stateOf([fact("a", "active", "2026-10-01")], true)).toBe("replied");
  });

  it("applies the rules in order: replied, in sequence, paused, queued, then the newest ended enrollment", () => {
    expect(stateOf([fact("a", "active", "2026-10-10"), fact("b", "replied", "2026-01-01")])).toBe("replied");
    expect(stateOf([fact("a", "active", "2026-01-01", { campaignStatus: "paused" }), fact("b", "active", "2026-01-02")])).toBe("in_sequence");
    expect(stateOf([fact("a", "pending", "2026-10-10"), fact("b", "active", "2026-01-01", { campaignStatus: "paused" })])).toBe("paused");
    expect(stateOf([fact("a", "completed", "2026-10-10"), fact("b", "pending", "2026-01-01")])).toBe("queued");
    expect(stateOf([fact("a", "completed", "2026-01-01"), fact("b", "bounced", "2026-05-01")])).toBe("stopped");
    expect(stateOf([fact("a", "completed", "2026-05-01"), fact("b", "bounced", "2026-01-01")])).toBe("finished");
  });

  it("never counts a removed enrollment", () => {
    const status = leadStatus({ enrollments: [fact("a", "removed", "2026-10-10"), fact("b", "completed", "2026-09-01")], lastOutboundAt: null, hasInbound: false });
    expect(status.state).toBe("finished");
    expect(status.enrollment?.campaignName).toBe("C-b");
    expect(status.otherCampaigns).toBe(0);
  });

  it("returns the deciding enrollment with its details and counts the other campaigns", () => {
    const next = new Date("2026-10-20T09:00:00Z");
    const sent = new Date("2026-10-18T09:00:00Z");
    const status = leadStatus({
      enrollments: [fact("a", "active", "2026-10-01", { currentStep: 2, lastSentAt: sent, nextSendAt: next }), fact("b", "completed", "2026-10-02"), fact("c", "removed", "2026-10-03")],
      lastOutboundAt: null,
      hasInbound: false,
    });
    expect(status).toEqual({
      state: "in_sequence",
      enrollment: { id: "a", campaignName: "C-a", step: 2, lastSentAt: sent, nextSendAt: next, stopReason: null },
      otherCampaigns: 1,
      lastContactAt: sent,
    });
    expect(leadStatus({ enrollments: [fact("a", "bounced", "2026-10-01", { stopReason: "bounced" })], lastOutboundAt: null, hasInbound: false }).enrollment?.stopReason).toBe("bounced");
  });

  it("takes the newest enrollment within a rule and breaks a tie on the id, whatever the input order", () => {
    expect(leadStatus({ enrollments: [fact("a", "active", "2026-01-01"), fact("b", "active", "2026-05-01")], lastOutboundAt: null, hasInbound: false }).enrollment?.id).toBe("b");
    const one = leadStatus({ enrollments: [fact("b", "active", "2026-01-01"), fact("a", "active", "2026-01-01")], lastOutboundAt: null, hasInbound: false });
    const two = leadStatus({ enrollments: [fact("a", "active", "2026-01-01"), fact("b", "active", "2026-01-01")], lastOutboundAt: null, hasInbound: false });
    expect(one.enrollment?.id).toBe("b");
    expect(two.enrollment?.id).toBe("b");
  });

  it("has a label for every state", () => {
    expect(LEAD_STATES.map((s) => LEAD_STATE_LABELS[s])).toEqual(["New", "Queued", "In sequence", "Paused", "Replied", "Finished", "Stopped"]);
  });
});

describe("latestContact", () => {
  const sent = (id: string, status: string, lastSentAt: string | null) => fact(id, status, "2026-01-01", { lastSentAt: lastSentAt ? new Date(lastSentAt) : null });

  it("shows a cold send that never got a reply", () => {
    expect(latestContact(null, [sent("a", "active", "2026-10-03T10:00:00Z")])?.toISOString()).toBe("2026-10-03T10:00:00.000Z");
  });

  it("takes the later of the message and the campaign step, removed enrollments included", () => {
    expect(latestContact(new Date("2026-10-05T10:00:00Z"), [sent("a", "active", "2026-10-03T10:00:00Z")])?.toISOString()).toBe("2026-10-05T10:00:00.000Z");
    expect(latestContact(new Date("2026-10-01T10:00:00Z"), [sent("a", "active", "2026-10-03T10:00:00Z"), sent("b", "removed", "2026-10-04T10:00:00Z")])?.toISOString()).toBe("2026-10-04T10:00:00.000Z");
  });

  it("is null when nothing was sent", () => {
    expect(latestContact(null, [sent("a", "pending", null)])).toBeNull();
    expect(latestContact(null, [])).toBeNull();
  });
});
