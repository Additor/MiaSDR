import { describe, expect, it } from "vitest";
import { canMoveEnrollment, ENROLLMENT_FROM, ENROLLMENT_STATUSES, LIVE_ENROLLMENT_STATUSES } from "./enrollment-status";

const OUTCOMES = ENROLLMENT_STATUSES.filter((s) => !(LIVE_ENROLLMENT_STATUSES as readonly string[]).includes(s));

describe("enrollment transitions", () => {
  it("moves a live enrollment to any outcome", () => {
    for (const from of LIVE_ENROLLMENT_STATUSES) for (const to of OUTCOMES) expect(canMoveEnrollment(from, to)).toBe(true);
  });

  it("keeps an outcome, except that a removed lead can be restored", () => {
    for (const from of OUTCOMES) {
      const exits = ENROLLMENT_STATUSES.filter((to) => canMoveEnrollment(from, to));
      expect(exits).toEqual(from === "removed" ? ["pending", "active"] : []);
    }
  });

  it("covers every status", () => {
    expect(Object.keys(ENROLLMENT_FROM).sort()).toEqual([...ENROLLMENT_STATUSES].sort());
  });
});
