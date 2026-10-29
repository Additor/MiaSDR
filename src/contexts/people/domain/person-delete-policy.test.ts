import { describe, expect, it } from "vitest";
import { leadDeleteBlock, mergeContactBlockers } from "./person-delete-policy";

describe("leadDeleteBlock", () => {
  const clean = { contact: false, history: false, outreach: [] };

  it("deletes a lead with no history, no counted send and no live enrollment in a running campaign", () => {
    expect(leadDeleteBlock(clean)).toBeNull();
  });

  it("ranks a visible send first, then a hidden one, then another member's personal campaign, then a running campaign", () => {
    expect(leadDeleteBlock({ ...clean, outreach: ["in_active_campaign", "has_hidden_sends", "has_sends", "personal_campaign_sends"] })).toBe("has_sends");
    expect(leadDeleteBlock({ ...clean, outreach: ["in_active_campaign", "personal_campaign_sends", "has_hidden_sends"] })).toBe("has_hidden_sends");
    expect(leadDeleteBlock({ ...clean, outreach: ["in_active_campaign", "personal_campaign_sends"] })).toBe("personal_campaign_sends");
    expect(leadDeleteBlock({ ...clean, outreach: ["in_active_campaign"] })).toBe("in_active_campaign");
  });

  it("keeps a lead with a record or an event, and a contact, as linked_records after the outreach reasons", () => {
    expect(leadDeleteBlock({ ...clean, history: true })).toBe("linked_records");
    expect(leadDeleteBlock({ ...clean, contact: true })).toBe("linked_records");
    expect(leadDeleteBlock({ contact: true, history: true, outreach: ["in_active_campaign"] })).toBe("in_active_campaign");
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
