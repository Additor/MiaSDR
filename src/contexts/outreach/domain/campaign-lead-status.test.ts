import { describe, expect, it } from "vitest";
import { campaignLeadState, campaignLeadStatus, enrollmentStatusesFor } from "./campaign-lead-status";

const at = new Date("2026-10-19T09:00:00Z");
const next = new Date("2026-10-21T09:00:00Z");
const row = (status: string, over: Partial<Parameters<typeof campaignLeadStatus>[0]> = {}) => ({ id: "e1", status, currentStep: 1, lastSentAt: at, nextSendAt: next, stopReason: null, ...over });
const campaign = (status: string) => ({ status, name: "Autumn push" });

describe("campaignLeadState", () => {
  it("follows the lead status rules for one enrollment and its campaign", () => {
    expect(campaignLeadState("pending", "active")).toBe("queued");
    expect(campaignLeadState("active", "active")).toBe("in_sequence");
    expect(campaignLeadState("active", "paused")).toBe("paused");
    expect(campaignLeadState("pending", "draft")).toBe("paused");
    expect(campaignLeadState("active", "completed")).toBe("paused");
    expect(campaignLeadState("replied", "paused")).toBe("replied");
    expect(campaignLeadState("completed", "active")).toBe("finished");
    for (const status of ["bounced", "suppressed", "failed", "cancelled"]) expect(campaignLeadState(status, "active"), status).toBe("stopped");
  });

  it("gives a removed or unknown enrollment no state", () => {
    expect(campaignLeadState("removed", "active")).toBeNull();
    expect(campaignLeadState("mystery", "active")).toBeNull();
  });

  it("lists the enrollment statuses behind a state", () => {
    expect(enrollmentStatusesFor("paused", "paused")).toEqual(["pending", "active"]);
    expect(enrollmentStatusesFor("paused", "active")).toEqual([]);
    expect(enrollmentStatusesFor("stopped", "active")).toEqual(["bounced", "suppressed", "failed", "cancelled"]);
  });
});

describe("campaignLeadStatus", () => {
  it("carries the step, the sends and the stop reason for the hover", () => {
    expect(campaignLeadStatus(row("bounced", { stopReason: "bounced", nextSendAt: null }), campaign("active"))).toEqual({
      state: "stopped",
      enrollment: { id: "e1", campaignName: "Autumn push", step: 1, lastSentAt: at, nextSendAt: null, stopReason: "bounced" },
      otherCampaigns: 0,
      lastContactAt: at,
    });
    expect(campaignLeadStatus(row("active"), campaign("active"))?.enrollment?.nextSendAt).toEqual(next);
    expect(campaignLeadStatus(row("removed"), campaign("active"))).toBeNull();
  });
});
