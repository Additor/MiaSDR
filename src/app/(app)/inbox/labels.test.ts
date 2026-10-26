import { describe, expect, it } from "vitest";
import { replyTypeSourceLabel, draftStatusLabel, waitingOn, workflowLabel } from "./labels";

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
    expect(replyTypeSourceLabel("human")).toBe("set by a person");
  });

  it("labels workflow states and says who acts next", () => {
    expect(workflowLabel("action_required")).toBe("Needs action");
    expect(waitingOn("action_required")).toBe("You");
    expect(waitingOn("error")).toBe("You");
    expect(waitingOn("waiting")).toBe("The person");
    expect(waitingOn("classifying")).toBe("AI");
    expect(waitingOn("closed")).toBe("No one");
  });
});
