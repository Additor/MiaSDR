import { describe, expect, it } from "vitest";
import { ConflictError, ValidationError } from "@/shared/errors";
import { pickAssignee, planAssign, planClaim } from "./assignment";

const ANN = "11111111-1111-4111-8111-111111111111";
const BOB = "22222222-2222-4222-8222-222222222222";
const CARL = "33333333-3333-4333-8333-333333333333";

describe("pickAssignee", () => {
  it("takes the first candidate who is still a member", () => {
    expect(pickAssignee([{ userId: ANN, isMember: true }, { userId: BOB, isMember: true }])).toBe(ANN);
  });

  it("skips a creator who left instead of leaving the conversation unassigned", () => {
    expect(pickAssignee([{ userId: CARL, isMember: false }, { userId: BOB, isMember: true }])).toBe(BOB);
  });

  it("answers null when nobody qualifies", () => {
    expect(pickAssignee([])).toBeNull();
    expect(pickAssignee([{ userId: CARL, isMember: false }])).toBeNull();
  });
});

describe("planClaim", () => {
  it("takes an unassigned conversation as a human choice", () => {
    expect(planClaim(null, ANN)).toEqual({ changed: true, assignedTo: ANN, source: "human", from: null });
  });

  it("changes nothing when you already hold it", () => {
    expect(planClaim(ANN, ANN)).toEqual({ changed: false, assignedTo: ANN });
  });

  it("refuses a conversation someone else holds", () => {
    expect(() => planClaim(BOB, ANN)).toThrow(ConflictError);
  });
});

describe("planAssign", () => {
  const base = { current: ANN as string | null, expected: ANN as string | null, target: BOB as string | null, targetIsMember: true };

  it("moves a conversation to another member as a human choice", () => {
    expect(planAssign(base)).toEqual({ changed: true, assignedTo: BOB, source: "human", from: ANN });
  });

  it("assigns an unassigned conversation when the person saw it unassigned", () => {
    expect(planAssign({ ...base, current: null, expected: null })).toEqual({ changed: true, assignedTo: BOB, source: "human", from: null });
  });

  it("unassigns with a null target and records that a person chose it, so the next reply does not assign again", () => {
    expect(planAssign({ ...base, target: null, targetIsMember: false })).toEqual({ changed: true, assignedTo: null, source: "cleared", from: ANN });
  });

  it("changes nothing when the target already holds it", () => {
    expect(planAssign({ ...base, current: BOB, expected: BOB })).toEqual({ changed: false, assignedTo: BOB });
    expect(planAssign({ ...base, current: null, expected: null, target: null, targetIsMember: false })).toEqual({ changed: false, assignedTo: null });
  });

  it("refuses when another change landed after the person looked", () => {
    expect(() => planAssign({ ...base, current: CARL })).toThrow(ConflictError);
    expect(() => planAssign({ ...base, expected: null })).toThrow(ConflictError);
  });

  it("refuses a target who is not a member, and says so without the word record", () => {
    expect(() => planAssign({ ...base, targetIsMember: false })).toThrow(ValidationError);
    expect(() => planAssign({ ...base, targetIsMember: false })).toThrow(/member of this organization/);
  });

  it("checks the conflict before the target, so a stale view is told first", () => {
    expect(() => planAssign({ ...base, expected: null, targetIsMember: false })).toThrow(ConflictError);
  });
});
