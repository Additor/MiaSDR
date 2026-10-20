import { describe, expect, it } from "vitest";
import { canonicalTimeZone } from "./time-zone";

describe("canonicalTimeZone", () => {
  it("returns the canonical name for a valid zone", () => {
    expect(canonicalTimeZone("Europe/Berlin")).toBe("Europe/Berlin");
    expect(canonicalTimeZone("utc")).toBe("UTC");
    expect(canonicalTimeZone("america/new_york")).toBe("America/New_York");
  });
  it("returns null for an unknown zone", () => {
    expect(canonicalTimeZone("Mars/Olympus")).toBeNull();
    expect(canonicalTimeZone("")).toBeNull();
    expect(canonicalTimeZone("not a zone")).toBeNull();
  });
});
