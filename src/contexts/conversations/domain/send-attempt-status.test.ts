import { describe, expect, it } from "vitest";
import { ATTEMPT_FINAL, canMoveAttempt, type AttemptStatus } from "./send-attempt-status";

const ALL: AttemptStatus[] = ["prepared", "sending", "sent", "failed", "delivery_uncertain", "reconciled"];

describe("send attempt transitions", () => {
  it("never leaves a final status", () => {
    for (const from of ATTEMPT_FINAL) for (const to of ALL) expect(canMoveAttempt(from, to)).toBe(false);
  });

  it("lets delivery_uncertain move only to sent, reconciled or failed", () => {
    expect(ALL.filter((to) => canMoveAttempt("delivery_uncertain", to)).sort()).toEqual(["failed", "reconciled", "sent"]);
  });
});
