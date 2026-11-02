import { describe, expect, it } from "vitest";
import { utcDayStart } from "./utc-day";

describe("utcDayStart", () => {
  it("returns midnight UTC", () => {
    expect(utcDayStart(new Date("2026-10-15T23:59:59Z")).toISOString()).toBe("2026-10-15T00:00:00.000Z");
  });
});
