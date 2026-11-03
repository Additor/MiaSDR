import { describe, expect, it } from "vitest";
import { APPLIED_PICK_STATUSES, PICK_FROM, PICK_STATUSES, isAppliedPick, pickFlags, pickResponse } from "./reply-type-pick";

const conversation = { latestInboundMessageId: "m1", contextVersion: 3 };
const pick = { messageId: "m1", status: "auto_applied", appliedGroupKey: "interested", expectedContextVersion: 3 };

describe("pickFlags", () => {
  it("an applied pick of the latest reply can be undone", () => {
    expect(pickFlags(pick, conversation)).toEqual({ latest: true, current: true, canUndo: true });
  });

  it("only the latest reply's pick can be undone", () => {
    expect(pickFlags({ ...pick, messageId: "m0" }, conversation)).toMatchObject({ latest: false, canUndo: false });
  });

  it("a pick with no applied type cannot be undone", () => {
    expect(pickFlags({ ...pick, status: "proposed", appliedGroupKey: null }, conversation).canUndo).toBe(false);
    expect(pickFlags({ ...pick, appliedGroupKey: null }, conversation).canUndo).toBe(false);
  });

  it("a version behind the conversation, or a stale status, is not current", () => {
    expect(pickFlags({ ...pick, expectedContextVersion: 2 }, conversation).current).toBe(false);
    expect(pickFlags({ ...pick, status: "stale" }, conversation).current).toBe(false);
  });
});

describe("pickResponse", () => {
  it("reads the fields it knows and drops the wrong types", () => {
    expect(pickResponse({ previousLocked: true, stopRequested: false, holdReason: "low_confidence", other: 1 })).toEqual({ previousLocked: true, stopRequested: false, holdReason: "low_confidence" });
    expect(pickResponse({ previousLocked: "yes", stopRequested: 1 })).toEqual({});
    expect(pickResponse(null)).toEqual({});
  });
});

describe("the status table", () => {
  it("names every status, and an AI pick's first statuses come from no other", () => {
    expect(Object.keys(PICK_FROM).sort()).toEqual([...PICK_STATUSES].sort());
    expect(PICK_FROM.proposed).toEqual([]);
    expect(PICK_FROM.auto_applied).toEqual([]);
    expect(PICK_FROM.failed).toEqual([]);
  });

  it("undo moves only an applied pick, and a bump only a held one", () => {
    expect(PICK_FROM.rejected).toEqual(APPLIED_PICK_STATUSES);
    expect(PICK_FROM.stale).toEqual(["proposed"]);
    expect(isAppliedPick("overridden")).toBe(true);
    expect(isAppliedPick("proposed")).toBe(false);
  });
});
