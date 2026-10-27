import { describe, expect, it } from "vitest";
import { draftStatusLabel, replyTypeSourceTip } from "./labels";

describe("inbox labels", () => {
  it("names every draft status without underscores", () => {
    for (const status of ["generating", "awaiting_review", "sending", "sent", "discarded", "stale", "failed", "delivery_uncertain"]) {
      expect(draftStatusLabel(status)).not.toMatch(/_/);
    }
    expect(draftStatusLabel("awaiting_review")).toBe("Awaiting review");
    expect(draftStatusLabel("stale")).toBe("Out of date");
  });

  it("falls back to a readable label for an unknown value", () => {
    expect(draftStatusLabel("on_hold")).toBe("On hold");
  });

  it("says who set the reply type", () => {
    expect(replyTypeSourceTip("ai")).toBe("Picked by the AI");
    expect(replyTypeSourceTip("human")).toBe("Set by a person");
    expect(replyTypeSourceTip("crm_sync")).toBe("Set by crm sync");
  });
});
