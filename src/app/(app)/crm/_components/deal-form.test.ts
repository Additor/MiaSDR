import { describe, expect, it } from "vitest";
import { DEFAULT_STAGE, NO_OWNER, dealFieldsReady, dealRequestFields, firstOpenChoice, initialDealFields, stageChoices } from "./deal-form";

describe("deal form", () => {
  const real = {
    virtual: false,
    stages: [
      { id: "s-new", name: "New", kind: "open" as const, position: 1 },
      { id: "s-won", name: "Won", kind: "won" as const, position: 2 },
      { id: "s-lost", name: "Lost", kind: "lost" as const, position: 3 },
    ],
  };
  const virtual = { virtual: true, stages: real.stages.map((s) => ({ ...s, id: null })) };

  it("offers every stage of a real list and only the default stage of a virtual one", () => {
    expect(stageChoices(real).map((c) => c.value)).toEqual(["s-new", "s-won", "s-lost"]);
    expect(stageChoices(virtual)).toEqual([{ value: DEFAULT_STAGE, label: "New", kind: "open" }]);
    expect(firstOpenChoice(real)).toBe("s-new");
    expect(firstOpenChoice(null)).toBeNull();
  });

  it("sends no stage for the virtual default, null for an empty amount and no owner for the none choice", () => {
    const values = { ...initialDealFields("Acme, Ada", "u1"), stage: DEFAULT_STAGE, owner: NO_OWNER };
    expect(dealRequestFields(values, true)).toEqual({ stageId: null, ownerId: null, title: "Acme, Ada", amount: null, currency: null, expectedCloseOn: null, lostReason: null });
    expect(dealRequestFields({ ...values, stage: "s-won", owner: "u1", amount: " 1200.50 " }, true)).toMatchObject({ stageId: "s-won", ownerId: "u1", amount: "1200.50", currency: "USD" });
    expect(dealRequestFields({ ...values, stage: "s-won" }, false)).toEqual({ stageId: "s-won", ownerId: null });
  });

  it("needs a stage, a title and a reason for a Lost stage", () => {
    const base = { ...initialDealFields("Title", "u1"), stage: "s-new" };
    expect(dealFieldsReady(base, real, true)).toBe(true);
    expect(dealFieldsReady({ ...base, title: " " }, real, true)).toBe(false);
    expect(dealFieldsReady({ ...base, title: " " }, real, false)).toBe(true);
    expect(dealFieldsReady({ ...base, stage: "s-lost" }, real, true)).toBe(false);
    expect(dealFieldsReady({ ...base, stage: "s-lost", lostReason: "Budget" }, real, true)).toBe(true);
    expect(dealFieldsReady({ ...base, stage: "s-gone" }, real, true)).toBe(false);
  });
});
