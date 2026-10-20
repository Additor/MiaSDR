import { describe, expect, it } from "vitest";
import { nextStep, presetSteps, providersForStep } from "./waterfall-steps";

const provider = (key: string, ...actions: string[]) => ({ key, actions: actions.map((a) => ({ key: a })) });
const hunter = provider("hunter", "verify-email", "find-work-email", "find-emails-by-company");
const zerobounce = provider("zerobounce", "verify-email");
const prospeo = provider("prospeo", "find-work-email");
const apollo = provider("apollo", "enrich-person", "enrich-company");
const usable = [hunter, zerobounce, prospeo, apollo];

describe("waterfall steps", () => {
  it("offers every provider for the first step and only matching ones after it", () => {
    const steps = [{ providerKey: "hunter", actionKey: "verify-email" }];
    expect(providersForStep(usable, steps, 0).map((p) => p.key)).toEqual(["hunter", "zerobounce", "prospeo", "apollo"]);
    expect(providersForStep(usable, steps, 1).map((p) => p.key)).toEqual(["hunter", "zerobounce"]);
  });

  it("adds the next unused provider with the first step's action, and nothing when none is left", () => {
    expect(nextStep(usable, [])).toEqual({ providerKey: "hunter", actionKey: "verify-email" });
    const one = [{ providerKey: "hunter", actionKey: "find-work-email" }];
    expect(nextStep(usable, one)).toEqual({ providerKey: "prospeo", actionKey: "find-work-email" });
    expect(nextStep(usable, [...one, { providerKey: "prospeo", actionKey: "find-work-email" }])).toBeNull();
  });

  it("lines up every provider that offers a preset's action", () => {
    expect(presetSteps(usable, "verify-email")).toEqual([
      { providerKey: "hunter", actionKey: "verify-email" },
      { providerKey: "zerobounce", actionKey: "verify-email" },
    ]);
    expect(presetSteps(usable, "enrich-company")).toHaveLength(1);
  });
});
