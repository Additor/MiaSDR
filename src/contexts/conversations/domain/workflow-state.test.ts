import { describe, expect, it } from "vitest";
import { afterManualCategory, afterPersonDecision, afterReopen, settlesAfterAiCategory, WORKFLOW_STATES } from "./workflow-state";

describe("workflow state", () => {
  it("keeps a closed conversation closed when a person decides, and brings any other back to someone", () => {
    expect(afterPersonDecision("closed")).toBe("closed");
    for (const state of WORKFLOW_STATES.filter((s) => s !== "closed")) expect(afterPersonDecision(state)).toBe("action_required");
  });

  it("reopens to work only when a reply waits", () => {
    expect(afterReopen(true)).toBe("action_required");
    expect(afterReopen(false)).toBe("idle");
  });

  it("moves resting handling to work for a category that wants a draft, and lets work rest for one that does not", () => {
    expect(afterManualCategory("idle", true)).toBe("action_required");
    expect(afterManualCategory("error", true)).toBe("action_required");
    expect(afterManualCategory("unclassified", true)).toBe("action_required");
    expect(afterManualCategory("waiting", true)).toBe("waiting");
    expect(afterManualCategory("action_required", false)).toBe("idle");
    expect(afterManualCategory("waiting", false)).toBe("waiting");
    expect(afterManualCategory("closed", false)).toBe("closed");
  });

  it("settles an AI category only when nothing is left to do", () => {
    expect(settlesAfterAiCategory("action_required", { wantsDraft: false, stopRequested: false })).toBe(true);
    expect(settlesAfterAiCategory("action_required", { wantsDraft: true, stopRequested: false })).toBe(false);
    expect(settlesAfterAiCategory("action_required", { wantsDraft: false, stopRequested: true })).toBe(false);
    expect(settlesAfterAiCategory("waiting", { wantsDraft: false, stopRequested: false })).toBe(false);
  });
});
