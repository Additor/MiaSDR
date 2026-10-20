import { describe, expect, it } from "vitest";
import { elapsed, formatDate, formatDateTime, formatUtc, relativeTime } from "./format-time";

describe("format-time", () => {
  const instant = new Date("2026-03-08T05:07:00Z");

  it("prints a fixed-width numeric date in the given zone", () => {
    expect(formatDateTime(instant, "UTC")).toBe("2026-03-08 05:07");
    expect(formatDateTime(instant, "Asia/Seoul")).toBe("2026-03-08 14:07");
    expect(formatDateTime(instant, "America/Los_Angeles")).toBe("2026-03-07 21:07");
    expect(formatDate(instant, "Asia/Seoul")).toBe("2026-03-08");
  });

  it("follows DST: Los Angeles is UTC-8 before the switch and UTC-7 after", () => {
    // 2026-03-08 is the spring-forward day; the switch happens at 10:00 UTC.
    expect(formatDateTime("2026-03-08T09:59:00Z", "America/Los_Angeles")).toBe("2026-03-08 01:59");
    expect(formatDateTime("2026-03-08T10:00:00Z", "America/Los_Angeles")).toBe("2026-03-08 03:00");
  });

  it("rolls the date over at local midnight and never prints hour 24", () => {
    expect(formatDateTime("2026-12-31T15:00:00Z", "Asia/Seoul")).toBe("2027-01-01 00:00");
    expect(formatDateTime("2026-12-31T14:59:00Z", "Asia/Seoul")).toBe("2026-12-31 23:59");
    expect(formatDate("2026-12-31T15:00:00Z", "UTC")).toBe("2026-12-31");
  });

  it("falls back to UTC for an unknown zone", () => {
    expect(formatDateTime(instant, "Not/AZone")).toBe("2026-03-08 05:07");
    expect(formatDateTime(instant, "")).toBe("2026-03-08 05:07");
  });

  it("accepts ISO strings and epoch milliseconds", () => {
    expect(formatDateTime("2026-03-08T05:07:00.000Z", "Asia/Seoul")).toBe("2026-03-08 14:07");
    expect(formatDateTime(instant.getTime(), "Asia/Seoul")).toBe("2026-03-08 14:07");
  });

  it("formats the UTC original for tooltips", () => {
    expect(formatUtc(instant)).toBe("2026-03-08 05:07 UTC");
  });

  it("returns an empty string for an invalid date", () => {
    expect(formatDateTime("not a date", "UTC")).toBe("");
    expect(formatDate(Number.NaN, "UTC")).toBe("");
    expect(formatUtc("not a date")).toBe("");
  });
});

describe("relativeTime", () => {
  const now = new Date("2026-10-16T12:00:00Z");
  const ago = (ms: number) => new Date(now.getTime() - ms);
  const MIN = 60_000;
  it.each([
    [10_000, "just now"],
    [5 * MIN, "5 min ago"],
    [3 * 60 * MIN, "3 h ago"],
    [30 * 60 * MIN, "yesterday"],
    [12 * 24 * 60 * MIN, "12 d ago"],
    [70 * 24 * 60 * MIN, "2 mo ago"],
    [800 * 24 * 60 * MIN, "2 y ago"],
  ])("prints %i ms as %s", (ms, text) => {
    expect(relativeTime(ago(ms), now)).toBe(text);
  });

  const DAY = 24 * 60 * MIN;
  it.each([
    [59 * MIN, "59 min ago"],
    [60 * MIN, "1 h ago"],
    [23 * 60 * MIN, "23 h ago"],
    [24 * 60 * MIN, "yesterday"],
    [48 * 60 * MIN, "2 d ago"],
    [29 * DAY, "29 d ago"],
    [30 * DAY, "1 mo ago"],
    [59 * DAY, "1 mo ago"],
    [60 * DAY, "2 mo ago"],
    [359 * DAY, "11 mo ago"],
    [360 * DAY, "11 mo ago"],
    [364 * DAY, "11 mo ago"],
    [365 * DAY, "1 y ago"],
    [366 * DAY, "1 y ago"],
    [729 * DAY, "1 y ago"],
    [730 * DAY, "2 y ago"],
  ])("prints a gap of %i ms as %s and never 0 y", (ms, text) => {
    expect(relativeTime(ago(ms), now)).toBe(text);
  });

  it("prints a future gap past a minute as soon and inside it as just now", () => {
    expect(relativeTime(new Date(now.getTime() + 60_000), now)).toBe("just now");
    expect(relativeTime(new Date(now.getTime() + 61_000), now)).toBe("soon");
  });

  it("prints a bad value as empty and a future one as soon", () => {
    expect(relativeTime("nope", now)).toBe("");
    expect(relativeTime(new Date(now.getTime() + 10 * MIN), now)).toBe("soon");
  });
});

describe("elapsed", () => {
  const now = new Date("2026-10-16T12:00:00Z");
  const ago = (ms: number) => new Date(now.getTime() - ms);
  const MIN = 60_000;
  const DAY = 24 * 60 * MIN;
  it.each([
    [10_000, "under a minute", "under a minute"],
    [MIN, "1 min", "1 minute"],
    [5 * MIN, "5 min", "5 minutes"],
    [60 * MIN, "1 h", "1 hour"],
    [3 * 60 * MIN, "3 h", "3 hours"],
    [DAY, "1 d", "1 day"],
    [12 * DAY, "12 d", "12 days"],
    [29 * DAY, "29 d", "29 days"],
    [30 * DAY, "1 mo", "1 month"],
    [70 * DAY, "2 mo", "2 months"],
    [362 * DAY, "11 mo", "11 months"],
    [365 * DAY, "1 y", "1 year"],
    [800 * DAY, "2 y", "2 years"],
  ])("prints %i ms as %s and, spelled out, %s", (ms, short, long) => {
    expect(elapsed(ago(ms), now)).toBe(short);
    expect(elapsed(ago(ms), now, true)).toBe(long);
  });

  it("reads a time in the future as under a minute and a bad date as empty", () => {
    expect(elapsed(new Date(now.getTime() + 5 * MIN), now)).toBe("under a minute");
    expect(elapsed("not a date", now)).toBe("");
  });
});
