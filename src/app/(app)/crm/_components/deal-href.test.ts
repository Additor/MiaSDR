import { describe, expect, it } from "vitest";
import { dealHref } from "./deal-href";

describe("dealHref", () => {
  it("carries an allowed origin and drops any other", () => {
    expect(dealHref("d1", "/crm/pipeline?q=Acme+Ltd")).toBe("/crm/deals/d1?from=%2Fcrm%2Fpipeline%3Fq%3DAcme%2BLtd");
    expect(dealHref("d1", "/crm/contacts/0b6f7c9e-1a2b-4c3d-8e9f-001122334455")).toBe("/crm/deals/d1?from=%2Fcrm%2Fcontacts%2F0b6f7c9e-1a2b-4c3d-8e9f-001122334455");
    expect(dealHref("d1", "/leads/0b6f7c9e-1a2b-4c3d-8e9f-001122334455")).toBe("/crm/deals/d1");
    expect(dealHref("d1", "//evil.test")).toBe("/crm/deals/d1");
    expect(dealHref("d1", null)).toBe("/crm/deals/d1");
  });
});
