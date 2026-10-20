import { describe, expect, it } from "vitest";
import { minutesUntilTestSlot, TEST_SEND_WINDOW_MINUTES } from "./test-send";

describe("minutesUntilTestSlot", () => {
  const now = new Date("2026-10-15T12:00:00Z");
  it("counts the minutes until the oldest send leaves the window", () => {
    expect(minutesUntilTestSlot(new Date("2026-10-15T11:20:00Z"), now)).toBe(20);
  });
  it("rounds up and never returns less than one minute", () => {
    expect(minutesUntilTestSlot(new Date(now.getTime() - TEST_SEND_WINDOW_MINUTES * 60_000 + 1_000), now)).toBe(1);
    expect(minutesUntilTestSlot(new Date(now.getTime() - 2 * TEST_SEND_WINDOW_MINUTES * 60_000), now)).toBe(1);
  });
});
