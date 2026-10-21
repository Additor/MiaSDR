import { describe, expect, it } from "vitest";
import { lookupKey } from "./enrichment-reuse";

describe("lookup key", () => {
  it("folds case, outer space and input order, and keeps providers and actions apart", () => {
    const key = lookupKey("zerobounce", "verify-email", { email: "Ada@Acme.com " });
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(lookupKey("zerobounce", "verify-email", { email: "ada@acme.com" })).toBe(key);
    expect(lookupKey("neverbounce", "verify-email", { email: "ada@acme.com" })).not.toBe(key);
    expect(lookupKey("hunter", "find-work-email", { fullName: "Ada", companyDomain: "acme.com" })).toBe(lookupKey("hunter", "find-work-email", { companyDomain: "acme.com", fullName: "Ada" }));
    expect(key).not.toContain("acme");
  });
});
