import { describe, expect, it } from "vitest";
import { timeOptions } from "./time-select";

describe("timeOptions", () => {
  it("steps every 30 minutes from 00:00 to 23:30", () => {
    const times = timeOptions("09:00");
    expect(times).toHaveLength(48);
    expect([times[0], times[1], times[18], times[47]]).toEqual(["00:00", "00:30", "09:00", "23:30"]);
  });

  it("adds 23:59 for the end of a day", () => {
    expect(timeOptions("18:00", true).at(-1)).toBe("23:59");
    expect(timeOptions("18:00")).not.toContain("23:59");
  });

  it("keeps a saved time off the step, in order, so a save sends it unchanged", () => {
    const times = timeOptions("09:15");
    expect(times).toHaveLength(49);
    expect(times.slice(18, 21)).toEqual(["09:00", "09:15", "09:30"]);
    expect(timeOptions("23:59", true).filter((t) => t === "23:59")).toHaveLength(1);
  });

  it("ignores a value that is not HH:mm", () => {
    expect(timeOptions("")).toHaveLength(48);
    expect(timeOptions("24:00")).toHaveLength(48);
  });
});
