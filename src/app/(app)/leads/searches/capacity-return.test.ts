import { describe, expect, it } from "vitest";
import { capacityReturnText } from "./capacity-return";

describe("capacityReturnText", () => {
  it("prints the return time in the organization zone with the zone name", () => {
    expect(capacityReturnText("2026-03-08T00:00:00.000Z", "Asia/Seoul")).toBe("2026-03-08 09:00 Asia/Seoul");
    expect(capacityReturnText(new Date("2026-03-08T00:00:00Z"), "UTC")).toBe("2026-03-08 00:00 UTC");
  });

  it("returns null without a usable time", () => {
    expect(capacityReturnText(null, "UTC")).toBeNull();
    expect(capacityReturnText(undefined, "UTC")).toBeNull();
    expect(capacityReturnText("not a date", "UTC")).toBeNull();
  });
});
