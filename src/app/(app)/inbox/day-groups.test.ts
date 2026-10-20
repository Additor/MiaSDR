import { describe, expect, it } from "vitest";
import { dayGroupInZone, groupByDayInZone, rowTimeLabel } from "./day-groups";

const now = new Date("2026-03-10T01:30:00Z");

describe("day groups in the organization zone", () => {
  it("counts the day in the given zone, not in UTC", () => {
    const lateEvening = new Date("2026-03-09T23:30:00Z");
    expect(dayGroupInZone(lateEvening, now, "UTC")).toBe("yesterday");
    // 01:30 UTC on Mar 10 is still Mar 9 in New York, so a message from 23:30 UTC on Mar 9 (Mar 9 evening) is today there.
    expect(dayGroupInZone(lateEvening, now, "America/New_York")).toBe("today");
    expect(dayGroupInZone(now, now, "Asia/Seoul")).toBe("today");
  });

  it("uses the same buckets as the UTC rule", () => {
    expect(dayGroupInZone(new Date("2026-03-08T12:00:00Z"), now, "UTC")).toBe("week");
    expect(dayGroupInZone(new Date("2026-03-03T12:00:00Z"), now, "UTC")).toBe("week");
    expect(dayGroupInZone(new Date("2026-03-02T12:00:00Z"), now, "UTC")).toBe("earlier");
  });

  it("treats a future message as today and a bad date as earlier", () => {
    expect(dayGroupInZone(new Date("2026-03-12T00:00:00Z"), now, "UTC")).toBe("today");
    expect(dayGroupInZone(new Date("nope"), now, "UTC")).toBe("earlier");
  });

  it("groups newest-first rows and keeps their order", () => {
    const rows = [
      { id: 1, at: new Date("2026-03-10T00:10:00Z") },
      { id: 2, at: new Date("2026-03-09T10:00:00Z") },
      { id: 3, at: new Date("2026-03-09T08:00:00Z") },
      { id: 4, at: new Date("2026-01-01T00:00:00Z") },
    ];
    const groups = groupByDayInZone(rows, (r) => r.at, now, "UTC");
    expect(groups.map((g) => [g.label, g.rows.map((r) => r.id)])).toEqual([
      ["Today", [1]],
      ["Yesterday", [2, 3]],
      ["Earlier", [4]],
    ]);
  });
});

describe("the time a row shows", () => {
  const at = new Date("2026-03-09T23:30:00Z");

  it("says the clock time under Today and Yesterday, in the organization's zone", () => {
    expect(rowTimeLabel(at, "today", "UTC")).toBe("23:30");
    expect(rowTimeLabel(at, "yesterday", "Asia/Seoul")).toBe("08:30");
  });

  it("says the date under older groups", () => {
    expect(rowTimeLabel(at, "week", "UTC")).toBe("2026-03-09");
    expect(rowTimeLabel(at, "earlier", "Asia/Seoul")).toBe("2026-03-10");
  });
});
