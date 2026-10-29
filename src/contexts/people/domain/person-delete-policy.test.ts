import { describe, expect, it } from "vitest";
import { leadDeleteBlock, mergeContactBlockers } from "./person-delete-policy";

describe("leadDeleteBlock", () => {
  const clean = { contact: false, history: false, outreach: [] };

  it("deletes a lead with no history, no counted send and no live enrollment in a running campaign", () => {
    expect(leadDeleteBlock(clean)).toBeNull();
  });

  it("ranks the reasons that keep the lead for every actor first: a visible send, a hidden one, a running campaign, history", () => {
    expect(leadDeleteBlock({ ...clean, outreach: ["in_active_campaign", "has_hidden_sends", "has_sends", "personal_campaign_sends"] })).toBe("has_sends");
    expect(leadDeleteBlock({ ...clean, outreach: ["in_active_campaign", "personal_campaign_sends", "has_hidden_sends"] })).toBe("has_hidden_sends");
    expect(leadDeleteBlock({ ...clean, outreach: ["personal_campaign_sends", "in_active_campaign"] })).toBe("in_active_campaign");
    expect(leadDeleteBlock({ contact: true, history: true, outreach: ["in_active_campaign"] })).toBe("in_active_campaign");
    expect(leadDeleteBlock({ ...clean, history: true })).toBe("linked_records");
    expect(leadDeleteBlock({ ...clean, contact: true })).toBe("linked_records");
  });

  it("names another member's personal campaign only when nothing else keeps the lead", () => {
    expect(leadDeleteBlock({ ...clean, outreach: ["personal_campaign_sends"] })).toBe("personal_campaign_sends");
    // The owner who is asked would meet the history, so the member reads that reason.
    expect(leadDeleteBlock({ ...clean, history: true, outreach: ["personal_campaign_sends"] })).toBe("linked_records");
  });
});

describe("mergeContactBlockers", () => {
  it("keeps the order of the lists and names send_in_flight once", () => {
    const merged = mergeContactBlockers<{ reason: string }>(
      [{ reason: "open_deals" }],
      [{ reason: "send_in_flight" }, { reason: "recent_send" }],
      [{ reason: "send_in_flight" }, { reason: "ai_job_running" }],
    );
    expect(merged.map((b) => b.reason)).toEqual(["open_deals", "send_in_flight", "recent_send", "ai_job_running"]);
  });
});
