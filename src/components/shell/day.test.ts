import { describe, expect, it } from "vitest";
import { formatDay, parseDay } from "./day";

describe("parseDay", () => {
  it("reads yyyy-MM-dd as that day at local midnight", () => {
    const date = parseDay("2026-03-08");
    expect([date?.getFullYear(), date?.getMonth(), date?.getDate(), date?.getHours()]).toEqual([2026, 2, 8, 0]);
  });

  it("refuses days that do not exist and other shapes", () => {
    for (const text of ["", "2026-02-30", "2026-13-01", "2026-3-8", "2026-03-08T00:00", "next week"]) expect(parseDay(text)).toBeNull();
  });

  it("keeps years under 100 as written", () => {
    expect(parseDay("0042-01-02")?.getFullYear()).toBe(42);
  });
});

describe("formatDay", () => {
  it("writes the local day back as yyyy-MM-dd", () => {
    for (const text of ["2026-03-08", "2020-01-02", "2024-02-29", "0042-01-02"]) expect(formatDay(parseDay(text)!)).toBe(text);
  });

  it("writes the local calendar day, not the UTC one", () => {
    expect(formatDay(new Date(2026, 9, 26, 23, 59))).toBe("2026-10-26");
  });
});
