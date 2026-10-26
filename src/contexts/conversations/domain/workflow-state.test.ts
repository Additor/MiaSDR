import { describe, expect, it } from "vitest";
import { afterPersonDecision, afterReopen, afterTypeChange, settlesAfterAiCategory, settlesAfterAiPick, WORKFLOW_STATES } from "./workflow-state";

describe("workflow state", () => {
  it("keeps a closed conversation closed when a person decides, and brings any other back to someone", () => {
    expect(afterPersonDecision("closed")).toBe("closed");
    for (const state of WORKFLOW_STATES.filter((s) => s !== "closed")) expect(afterPersonDecision(state)).toBe("action_required");
  });

  it("reopens to work only when a reply waits", () => {
    expect(afterReopen(true)).toBe("action_required");
    expect(afterReopen(false)).toBe("idle");
  });

  it("moves resting handling to work for a type change that wants a draft, and lets work rest for one that does not", () => {
    expect(afterTypeChange("idle", { wantsDraft: true })).toBe("action_required");
    expect(afterTypeChange("error", { wantsDraft: true })).toBe("action_required");
    expect(afterTypeChange("unclassified", { wantsDraft: true })).toBe("action_required");
    expect(afterTypeChange("waiting", { wantsDraft: true })).toBe("waiting");
    expect(afterTypeChange("action_required", { wantsDraft: false })).toBe("idle");
    expect(afterTypeChange("waiting", { wantsDraft: false })).toBe("waiting");
    expect(afterTypeChange("closed", { wantsDraft: false })).toBe("closed");
  });

  it("settles an AI pick only when it applied, needs no check after, wants no draft and asked nothing to stop", () => {
    const applied = { hold: null, needsLooksRight: false, wantsDraft: false, followUps: "stop" } as const;
    expect(settlesAfterAiPick("action_required", applied, false)).toBe(true);
    expect(settlesAfterAiPick("action_required", { ...applied, wantsDraft: true }, false)).toBe(false);
    expect(settlesAfterAiPick("action_required", { ...applied, needsLooksRight: true }, false)).toBe(false);
    expect(settlesAfterAiPick("action_required", { ...applied, hold: "requires_review" }, false)).toBe(false);
    expect(settlesAfterAiPick("action_required", applied, true)).toBe(false);
    expect(settlesAfterAiPick("waiting", applied, false)).toBe(false);
  });

  it("settles an AI category only when nothing is left to do (the rule before type rules)", () => {
    expect(settlesAfterAiCategory("action_required", { wantsDraft: false, stopRequested: false })).toBe(true);
    expect(settlesAfterAiCategory("action_required", { wantsDraft: true, stopRequested: false })).toBe(false);
    expect(settlesAfterAiCategory("action_required", { wantsDraft: false, stopRequested: true })).toBe(false);
    expect(settlesAfterAiCategory("waiting", { wantsDraft: false, stopRequested: false })).toBe(false);
  });
});
