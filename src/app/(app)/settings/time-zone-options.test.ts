import { describe, expect, it } from "vitest";
import { timeZoneOptions } from "./time-zone-options";

describe("timeZoneOptions", () => {
  it("puts UTC first and keeps the supported order", () => {
    expect(timeZoneOptions(["Asia/Seoul", "America/New_York"])).toEqual(["UTC", "Asia/Seoul", "America/New_York"]);
  });

  it("lists UTC once when the runtime also supports it", () => {
    expect(timeZoneOptions(["Asia/Seoul", "UTC"])).toEqual(["UTC", "Asia/Seoul"]);
  });

  it("adds a saved zone this runtime does not know", () => {
    expect(timeZoneOptions(["Asia/Seoul"], "Asia/Kolkata_Old")).toEqual(["UTC", "Asia/Kolkata_Old", "Asia/Seoul"]);
  });

  it("does not repeat a known current zone", () => {
    expect(timeZoneOptions(["Asia/Seoul"], "Asia/Seoul")).toEqual(["UTC", "Asia/Seoul"]);
  });
});
