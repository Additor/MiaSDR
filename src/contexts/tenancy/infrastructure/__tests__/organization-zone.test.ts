import { describe, expect, it } from "vitest";
import { organizationZoneOf } from "../drizzle-organization-store";

describe("organization zone", () => {
  it("takes the settings row first, then the organization column, then UTC", () => {
    expect(organizationZoneOf("Asia/Seoul", "UTC")).toBe("Asia/Seoul");
    expect(organizationZoneOf(null, "Europe/Berlin")).toBe("Europe/Berlin");
    expect(organizationZoneOf("Not/AZone", "Europe/Berlin")).toBe("Europe/Berlin");
    expect(organizationZoneOf(undefined, "nonsense")).toBe("UTC");
    expect(organizationZoneOf(undefined, undefined)).toBe("UTC");
  });
});
