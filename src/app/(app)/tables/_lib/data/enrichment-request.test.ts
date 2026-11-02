import { describe, expect, it } from "vitest";
import { editFormOf, SPEND_CAP_ERROR, spendCapInvalid, toCreateBody, toEditPatch, type EnrichmentEditValues } from "./enrichment-request";

const find = { providerKey: "hunter", actionKey: "find-email" };
const verify = (providerKey: string) => ({ providerKey, actionKey: "verify-email" });
const base = { inputs: { domain: "site", name: "" }, selectedOutputs: ["email"], afterColumnId: "c1", autoRun: false, delay: "2", reuseDays: "30" };

describe("spendCapInvalid", () => {
  it("accepts empty, zero and dollars, and refuses the rest", () => {
    for (const text of ["", "  ", "0", "1.25", "$3"]) expect(spendCapInvalid(text)).toBe(false);
    for (const text of ["abc", "-1", "1,5"]) expect(spendCapInvalid(text)).toBe(true);
  });
});

describe("toCreateBody", () => {
  it("sends one provider as an enrichment, with the used inputs and no caps", () => {
    expect(toCreateBody({ ...base, name: "Email", steps: [find], maxCost: "5", maxCredits: "2", waitOnLimit: true, stopAtCatchAll: true })).toEqual({
      kind: "enrichment",
      name: "Email",
      ...find,
      inputs: { domain: "site" },
      selectedOutputs: ["email"],
      afterColumnId: "c1",
      autoRun: false,
      delaySeconds: 2,
      reuseDays: 30,
    });
  });

  it("leaves the name out for an action the server names", () => {
    expect(toCreateBody({ ...base, steps: [find] })).not.toHaveProperty("name");
  });

  it("sends several providers as a waterfall with its caps", () => {
    const steps = [verify("a"), verify("b")];
    expect(toCreateBody({ ...base, name: "Verdict", steps, maxCost: "1.25", maxCredits: "2", waitOnLimit: true, stopAtCatchAll: true })).toMatchObject({
      kind: "waterfall",
      name: "Verdict",
      steps,
      maxCostCents: 125,
      maxCredits: 2,
      onRateLimit: "wait",
      settledStatuses: expect.arrayContaining(["catch_all"]),
    });
  });

  it("leaves out the caps nobody set, and the catch-all stop for an action that has no verdict", () => {
    const body = toCreateBody({ ...base, name: "Email", steps: [find, { ...find, providerKey: "apollo" }], maxCost: " ", stopAtCatchAll: true });
    for (const key of ["maxCostCents", "maxCredits", "onRateLimit", "settledStatuses"]) expect(body).not.toHaveProperty(key);
  });

  it("keeps a $0 cap that was typed", () => {
    expect(toCreateBody({ ...base, name: "Email", steps: [find, { ...find, providerKey: "apollo" }], maxCost: "0" })).toMatchObject({ maxCostCents: 0 });
  });

  it("never turns an invalid cap into $0", () => {
    expect(toCreateBody({ ...base, name: "Email", steps: [find, { ...find, providerKey: "apollo" }], maxCost: "abc" })).not.toHaveProperty("maxCostCents");
  });
});

describe("toEditPatch", () => {
  const initial: EnrichmentEditValues = { inputs: { domain: "site" }, autoRun: false, delay: "0", reuseDays: "30", stopAtCatchAll: false, maxCost: "1.5", maxCredits: "", waitOnLimit: false };
  const waterfall = { columnId: "c1", isWaterfall: true };

  it("answers null when nothing changed", () => {
    expect(toEditPatch(initial, initial, waterfall)).toEqual({ patch: null });
  });

  it("refuses a spend cap that is no amount, so it cannot save as $0", () => {
    expect(toEditPatch({ ...initial, maxCost: "abc", autoRun: true }, initial, waterfall)).toEqual({ error: SPEND_CAP_ERROR });
  });

  it("clears a cap left empty and saves a typed one in cents", () => {
    expect(toEditPatch({ ...initial, maxCost: "" }, initial, waterfall)).toEqual({ patch: { columnId: "c1", maxCostCents: null } });
    expect(toEditPatch({ ...initial, maxCost: "0" }, initial, waterfall)).toEqual({ patch: { columnId: "c1", maxCostCents: 0 } });
  });

  it("sends only what changed, with empty inputs dropped", () => {
    expect(toEditPatch({ ...initial, inputs: { domain: "other", name: "" }, autoRun: true, delay: "3", maxCredits: "2", waitOnLimit: true }, initial, waterfall)).toEqual({
      patch: { columnId: "c1", inputs: { domain: "other" }, autoRun: true, delaySeconds: 3, maxCredits: 2, onRateLimit: "wait" },
    });
    expect(toEditPatch({ ...initial, waitOnLimit: true, stopAtCatchAll: true }, initial, waterfall)).toMatchObject({ patch: { onRateLimit: "wait", settledStatuses: expect.arrayContaining(["catch_all"]) } });
    expect(toEditPatch({ ...initial, stopAtCatchAll: true }, { ...initial, stopAtCatchAll: true }, waterfall)).toEqual({ patch: null });
    expect(toEditPatch(initial, { ...initial, stopAtCatchAll: true }, waterfall)).toEqual({ patch: { columnId: "c1", settledStatuses: null } });
  });

  it("ignores the caps of a column with one provider", () => {
    expect(toEditPatch({ ...initial, maxCost: "abc", maxCredits: "2", waitOnLimit: true }, initial, { columnId: "c1", isWaterfall: false })).toEqual({ patch: null });
  });
});

describe("editFormOf", () => {
  it("reads a saved column's config", () => {
    expect(editFormOf({ autoRun: true, config: { inputs: { a: "b" }, delaySeconds: 3, reuseDays: 7, settledStatuses: ["valid", "catch_all"], maxCostCents: 125, maxCredits: 2, onRateLimit: "wait" } })).toEqual({
      inputs: { a: "b" },
      autoRun: true,
      delay: "3",
      reuseDays: "7",
      stopAtCatchAll: true,
      maxCost: "1.25",
      maxCredits: "2",
      waitOnLimit: true,
    });
  });

  it("starts empty without caps, so an untouched form changes nothing", () => {
    const form = editFormOf({ autoRun: false, config: {} });
    expect(form).toMatchObject({ maxCost: "", maxCredits: "", waitOnLimit: false, stopAtCatchAll: false, delay: "0" });
    expect(toEditPatch(form, form, { columnId: "c1", isWaterfall: true })).toEqual({ patch: null });
  });
});
