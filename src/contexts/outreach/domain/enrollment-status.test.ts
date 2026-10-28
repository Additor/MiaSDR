import { describe, expect, it } from "vitest";
import { canMoveEnrollment, ENROLLMENT_FROM, ENROLLMENT_STATUSES, failedOutcome, haltOutcome, LIVE_ENROLLMENT_STATUSES, OUTREACH_HALTS } from "./enrollment-status";

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

describe("enrollment outcomes", () => {
  it("ends a live enrollment for every halt and stores the halt as the reason", () => {
    for (const halt of OUTREACH_HALTS) {
      const outcome = haltOutcome(halt);
      expect(outcome.reason).toBe(halt);
      for (const from of LIVE_ENROLLMENT_STATUSES) expect(canMoveEnrollment(from, outcome.status), halt).toBe(true);
    }
  });

  it("maps the halts to their statuses", () => {
    expect(Object.fromEntries(OUTREACH_HALTS.map((h) => [h, haltOutcome(h).status]))).toEqual({
      replied: "replied",
      bounced: "bounced",
      unsubscribed: "suppressed",
      complaint: "suppressed",
      manual: "suppressed",
      do_not_contact: "suppressed",
      converted: "cancelled",
    });
  });

  it("bounds the provider message a failure carries", () => {
    expect(failedOutcome("send_failed", "Mailbox full")).toEqual({ status: "failed", reason: "send_failed: Mailbox full" });
    expect(failedOutcome("profile_lookup_failed", "x".repeat(900)).reason).toHaveLength(500);
  });
});
