import { describe, expect, it } from "vitest";
import { leadContactPoints } from "./lead-activity";

const lead = (over: Partial<{ email: string | null; linkedinSlug: string | null; linkedinUrl: string | null }> = {}) => ({ email: null, linkedinSlug: null, linkedinUrl: null, ...over });

describe("leadContactPoints", () => {
  it("builds a mailto link from the address", () => {
    expect(leadContactPoints(lead({ email: "jane@x.com" })).email).toEqual({ address: "jane@x.com", href: "mailto:jane@x.com" });
  });

  it("treats a missing or unusable address as no email", () => {
    expect(leadContactPoints(lead()).email).toBeNull();
    expect(leadContactPoints(lead({ email: "not an address" })).email).toBeNull();
    expect(leadContactPoints(lead({ email: "a@b.com>x" })).email).toBeNull();
  });

  it("uses the stored profile URL", () => {
    expect(leadContactPoints(lead({ linkedinUrl: "https://www.linkedin.com/in/jane/", linkedinSlug: "other" })).linkedin).toEqual({ href: "https://www.linkedin.com/in/jane/" });
  });

  it("builds the canonical URL when only the slug exists", () => {
    expect(leadContactPoints(lead({ linkedinSlug: "jane-doe" })).linkedin).toEqual({ href: "https://www.linkedin.com/in/jane-doe/" });
  });

  it("falls back to the slug when the stored value is not an http(s) link", () => {
    expect(leadContactPoints(lead({ linkedinUrl: "ACoAAB1234567890abcdefg", linkedinSlug: "jane-doe" })).linkedin?.href).toBe("https://www.linkedin.com/in/jane-doe/");
    expect(leadContactPoints(lead({ linkedinUrl: "javascript:alert(1)" })).linkedin).toBeNull();
  });

  it("reports no LinkedIn when neither value exists", () => {
    expect(leadContactPoints(lead()).linkedin).toBeNull();
  });
});
