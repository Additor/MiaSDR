import { describe, expect, it } from "vitest";
import { defaultWorkingHours, isWithinWorkingHours, isValidTimeZone, startOfLocalDay, type WorkingHours } from "./working-hours";

const seoul = defaultWorkingHours("Asia/Seoul");

describe("isWithinWorkingHours", () => {
  it("is open on a weekday inside the window, in the zone's local time", () => {
    // Wed 2026-10-14 10:00 in Seoul is 01:00 UTC.
    expect(isWithinWorkingHours(new Date("2026-10-14T01:00:00Z"), seoul)).toBe(true);
  });
  it("is closed before the start, at the end, and at night", () => {
    expect(isWithinWorkingHours(new Date("2026-10-13T23:59:00Z"), seoul)).toBe(false); // 08:59
    expect(isWithinWorkingHours(new Date("2026-10-14T09:00:00Z"), seoul)).toBe(false); // 18:00 sharp
    expect(isWithinWorkingHours(new Date("2026-10-14T14:00:00Z"), seoul)).toBe(false); // 23:00
  });
  it("is closed on weekends", () => {
    expect(isWithinWorkingHours(new Date("2026-10-17T01:00:00Z"), seoul)).toBe(false); // Saturday 10:00
  });
  it("uses the zone's weekday, not UTC's", () => {
    // Sun 2026-10-18 20:00 UTC is Monday 05:00... too early; Mon 00:30 UTC is Mon 09:30 in Seoul.
    expect(isWithinWorkingHours(new Date("2026-10-19T00:30:00Z"), seoul)).toBe(true);
  });
  it("never sends when every day is off", () => {
    const off: WorkingHours = { timeZone: "UTC", days: {} };
    expect(isWithinWorkingHours(new Date("2026-10-14T12:00:00Z"), off)).toBe(false);
  });
  it("supports an overnight window that began yesterday", () => {
    const night: WorkingHours = { timeZone: "UTC", days: { "1": [{ start: "22:00", end: "06:00" }] } };
    expect(isWithinWorkingHours(new Date("2026-10-12T23:00:00Z"), night)).toBe(true); // Mon 23:00
    expect(isWithinWorkingHours(new Date("2026-10-13T05:00:00Z"), night)).toBe(true); // Tue 05:00, window began Monday
    expect(isWithinWorkingHours(new Date("2026-10-13T07:00:00Z"), night)).toBe(false);
  });
});

describe("startOfLocalDay", () => {
  it("returns the instant local midnight began", () => {
    expect(startOfLocalDay(new Date("2026-10-14T01:00:00Z"), "Asia/Seoul").toISOString()).toBe("2026-10-13T15:00:00.000Z");
    expect(startOfLocalDay(new Date("2026-10-14T20:00:00Z"), "Asia/Seoul").toISOString()).toBe("2026-10-14T15:00:00.000Z");
  });
  it("handles zones behind UTC", () => {
    expect(startOfLocalDay(new Date("2026-10-14T03:00:00Z"), "America/Los_Angeles").toISOString()).toBe("2026-10-13T07:00:00.000Z");
  });
  it("stays correct across a DST change", () => {
    // US clocks go back on 2026-11-01: that local day is 25 hours long.
    expect(startOfLocalDay(new Date("2026-11-01T20:00:00Z"), "America/New_York").toISOString()).toBe("2026-11-01T04:00:00.000Z");
    expect(startOfLocalDay(new Date("2026-11-02T12:00:00Z"), "America/New_York").toISOString()).toBe("2026-11-02T05:00:00.000Z");
  });
});

describe("isValidTimeZone", () => {
  it("accepts IANA names and rejects junk", () => {
    expect(isValidTimeZone("Asia/Seoul")).toBe(true);
    expect(isValidTimeZone("Mars/Base")).toBe(false);
  });
});
