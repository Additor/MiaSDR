import { describe, expect, it } from "vitest";
import { localDay } from "./local-day";

describe("localDay", () => {
  const t = new Date("2026-10-14T23:30:00Z");

  it("uses UTC by default and for unknown zones", () => {
    expect(localDay(t, undefined)).toBe("2026-10-14");
    expect(localDay(t, null)).toBe("2026-10-14");
    expect(localDay(t, "")).toBe("2026-10-14");
    expect(localDay(t, "Mars/Olympus")).toBe("2026-10-14");
  });

  it("moves the day across zones", () => {
    expect(localDay(t, "Asia/Seoul")).toBe("2026-10-15");
    expect(localDay(t, "America/Los_Angeles")).toBe("2026-10-14");
    expect(localDay(new Date("2026-10-14T03:00:00Z"), "America/Los_Angeles")).toBe("2026-10-13");
    expect(localDay(new Date("2026-10-14T10:00:00Z"), "Pacific/Kiritimati")).toBe("2026-10-15");
  });

  it("holds one day through a 23 hour spring-forward day", () => {
    // New York 2026-03-08: clocks jump 02:00 to 03:00, local midnight is 05:00Z.
    expect(localDay(new Date("2026-03-08T04:59:59Z"), "America/New_York")).toBe("2026-03-07");
    expect(localDay(new Date("2026-03-08T05:00:00Z"), "America/New_York")).toBe("2026-03-08");
    expect(localDay(new Date("2026-03-09T03:59:59Z"), "America/New_York")).toBe("2026-03-08");
    expect(localDay(new Date("2026-03-09T04:00:00Z"), "America/New_York")).toBe("2026-03-09");
  });

  it("holds one day through a 25 hour fall-back day", () => {
    // New York 2026-11-01: local midnight is 04:00Z, next midnight 05:00Z the day after (25 hours).
    expect(localDay(new Date("2026-11-01T03:59:59Z"), "America/New_York")).toBe("2026-10-31");
    expect(localDay(new Date("2026-11-01T04:00:00Z"), "America/New_York")).toBe("2026-11-01");
    expect(localDay(new Date("2026-11-02T04:59:59Z"), "America/New_York")).toBe("2026-11-01");
    expect(localDay(new Date("2026-11-02T05:00:00Z"), "America/New_York")).toBe("2026-11-02");
  });

  it("handles a half hour offset and a zone without DST", () => {
    expect(localDay(new Date("2026-10-14T18:30:00Z"), "Asia/Kolkata")).toBe("2026-10-15");
    expect(localDay(new Date("2026-10-14T18:29:59Z"), "Asia/Kolkata")).toBe("2026-10-14");
  });
});
