import { describe, expect, it } from "vitest";
import { canMoveDraft, DRAFT_FROM, DRAFT_STATUSES, IN_FLIGHT_DRAFT_STATUSES, PENDING_DRAFT_STATUSES, RETIRABLE_DRAFT_STATUSES, UNSENT_DRAFT_STATUSES } from "./draft-status";

describe("draft transitions", () => {
  it("never leaves sent or discarded", () => {
    for (const from of ["sent", "discarded"] as const) for (const to of DRAFT_STATUSES) expect(canMoveDraft(from, to)).toBe(false);
  });

  it("retires only a draft no send has started on", () => {
    for (const status of RETIRABLE_DRAFT_STATUSES) expect(IN_FLIGHT_DRAFT_STATUSES).not.toContain(status);
    expect(canMoveDraft("sending", "stale")).toBe(false);
    expect(canMoveDraft("delivery_uncertain", "discarded")).toBe(false);
  });

  it("settles an in-flight draft only through its send attempt", () => {
    for (const from of IN_FLIGHT_DRAFT_STATUSES) {
      expect(DRAFT_STATUSES.filter((to) => canMoveDraft(from, to)).every((to) => ["awaiting_review", "sent", "failed", "delivery_uncertain"].includes(to))).toBe(true);
    }
  });

  it("names each group as a subset of the statuses", () => {
    for (const group of [UNSENT_DRAFT_STATUSES, RETIRABLE_DRAFT_STATUSES, IN_FLIGHT_DRAFT_STATUSES, PENDING_DRAFT_STATUSES]) {
      for (const status of group) expect(DRAFT_STATUSES).toContain(status);
    }
    expect(Object.keys(DRAFT_FROM).sort()).toEqual([...DRAFT_STATUSES].sort());
  });
});
