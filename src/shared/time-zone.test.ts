import { describe, expect, it } from "vitest";
import { calendarDayInZone, canonicalTimeZone, isCalendarDay, LEGACY_ZONE_ALIASES, shiftDay, startOfDayInZone } from "./time-zone";

const TABLE: Array<[string, string]> = [
  ["Africa/Asmera", "Africa/Asmara"],
  ["America/Buenos_Aires", "America/Argentina/Buenos_Aires"],
  ["America/Catamarca", "America/Argentina/Catamarca"],
  ["America/Coral_Harbour", "America/Atikokan"],
  ["America/Cordoba", "America/Argentina/Cordoba"],
  ["America/Godthab", "America/Nuuk"],
  ["America/Indianapolis", "America/Indiana/Indianapolis"],
  ["America/Jujuy", "America/Argentina/Jujuy"],
  ["America/Louisville", "America/Kentucky/Louisville"],
  ["America/Mendoza", "America/Argentina/Mendoza"],
  ["Asia/Calcutta", "Asia/Kolkata"],
  ["Asia/Katmandu", "Asia/Kathmandu"],
  ["Asia/Rangoon", "Asia/Yangon"],
  ["Asia/Saigon", "Asia/Ho_Chi_Minh"],
  ["Atlantic/Faeroe", "Atlantic/Faroe"],
  ["Europe/Kiev", "Europe/Kyiv"],
  ["Pacific/Enderbury", "Pacific/Kanton"],
  ["Pacific/Ponape", "Pacific/Pohnpei"],
  ["Pacific/Truk", "Pacific/Chuuk"],
];

describe("canonicalTimeZone", () => {
  it.each(TABLE)("maps %s to %s", (legacy, current) => {
    expect(canonicalTimeZone(legacy)).toBe(current);
    expect(canonicalTimeZone(current)).toBe(current);
  });

  it("covers all 19 legacy ids and nothing else", () => {
    expect(Object.keys(LEGACY_ZONE_ALIASES).sort()).toEqual(TABLE.map(([legacy]) => legacy).sort());
  });

  it("folds case, keeps current names and UTC", () => {
    expect(canonicalTimeZone("asia/calcutta")).toBe("Asia/Kolkata");
    expect(canonicalTimeZone("europe/berlin")).toBe("Europe/Berlin");
    expect(canonicalTimeZone("utc")).toBe("UTC");
  });

  it("returns null for unknown, empty or missing zones", () => {
    for (const bad of ["Mars/Olympus", "", "not a zone", null, undefined]) expect(canonicalTimeZone(bad)).toBeNull();
  });
});

describe("calendar days in a zone", () => {
  it("finds the day an instant falls on in a zone", () => {
    const at = new Date("2026-10-14T16:30:00Z");
    expect(calendarDayInZone(at, "UTC")).toBe("2026-10-14");
    expect(calendarDayInZone(at, "Asia/Seoul")).toBe("2026-10-15");
    expect(calendarDayInZone(at, "America/Los_Angeles")).toBe("2026-10-14");
    expect(calendarDayInZone(new Date("2026-10-14T03:00:00Z"), "America/Los_Angeles")).toBe("2026-10-13");
  });

  it("starts a day at local midnight, including across a daylight-saving change", () => {
    expect(startOfDayInZone("2026-10-14", "UTC").toISOString()).toBe("2026-10-14T00:00:00.000Z");
    expect(startOfDayInZone("2026-10-14", "Asia/Seoul").toISOString()).toBe("2026-10-13T15:00:00.000Z");
    expect(startOfDayInZone("2026-10-14", "America/Los_Angeles").toISOString()).toBe("2026-10-14T07:00:00.000Z");
    // US clocks go back on 2026-11-01: that day has 25 hours, so the next day starts 25 hours later.
    const start = startOfDayInZone("2026-11-01", "America/Los_Angeles");
    const next = startOfDayInZone(shiftDay("2026-11-01", 1), "America/Los_Angeles");
    expect(start.toISOString()).toBe("2026-11-01T07:00:00.000Z");
    expect(next.getTime() - start.getTime()).toBe(25 * 3_600_000);
  });

  it("shifts a day by calendar days and recognizes real days only", () => {
    expect(shiftDay("2026-10-31", 1)).toBe("2026-11-01");
    expect(shiftDay("2026-03-01", -1)).toBe("2026-02-28");
    expect(shiftDay("2028-02-28", 1)).toBe("2028-02-29");
    expect(isCalendarDay("2026-10-14")).toBe(true);
    expect(isCalendarDay("2026-02-31")).toBe(false);
    expect(isCalendarDay("soon")).toBe(false);
  });
});
