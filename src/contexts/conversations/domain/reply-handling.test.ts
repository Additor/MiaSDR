import { describe, expect, it } from "vitest";
import { ConflictError, ValidationError } from "@/shared/errors";
import { byGroupThenOrder, checkReplyTypeChange, lockAfterPersonMove, lockBeforePick, parseInstructionBlocks } from "./reply-handling";

const before = { groupKey: "interested", replyTypeId: "s1", replyTypeLocked: false, contextVersion: 3, workflowState: "waiting" };

describe("type change rules", () => {
  it("accepts a change to another type and locks for any move into the customer group", () => {
    expect(checkReplyTypeChange({ before, target: { groupKey: "interested", replyTypeId: "s2", systemRole: null }, expectedContextVersion: 3, confirmUnlock: false })).toEqual({ replyTypeLocked: false });
    expect(checkReplyTypeChange({ before, target: { groupKey: "customer", replyTypeId: "c1", systemRole: "customer" }, expectedContextVersion: 3, confirmUnlock: false })).toEqual({ replyTypeLocked: true });
    // Renewal: a second type of the customer group, without a role.
    expect(checkReplyTypeChange({ before, target: { groupKey: "customer", replyTypeId: "c2", systemRole: null }, expectedContextVersion: 3, confirmUnlock: false })).toEqual({ replyTypeLocked: true });
    // A change to the group alone.
    expect(checkReplyTypeChange({ before, target: { groupKey: "customer", replyTypeId: null, systemRole: null }, expectedContextVersion: 3, confirmUnlock: false })).toEqual({ replyTypeLocked: true });
  });

  it("locks by the target group alone, whatever the record had before", () => {
    expect(lockAfterPersonMove({ groupKey: "customer" })).toBe(true);
    expect(lockAfterPersonMove({ groupKey: "interested" })).toBe(false);
    expect(lockAfterPersonMove({ groupKey: "other" })).toBe(false);
  });

  it("gives back the stored lock before a pick, and falls back to the previous group", () => {
    expect(lockBeforePick({ previousLocked: false }, "customer")).toBe(false);
    expect(lockBeforePick({ previousLocked: true }, "customer")).toBe(true);
    expect(lockBeforePick({}, "customer")).toBe(true);
    expect(lockBeforePick(null, "interested")).toBe(false);
    expect(lockBeforePick(null, null)).toBe(false);
  });

  it("keeps the lock for a change inside the locked group", () => {
    const locked = { ...before, groupKey: "customer", replyTypeId: "c1", replyTypeLocked: true };
    expect(checkReplyTypeChange({ before: locked, target: { groupKey: "customer", replyTypeId: "c2", systemRole: null }, expectedContextVersion: 3, confirmUnlock: false })).toEqual({ replyTypeLocked: true });
  });

  it("rejects a stale version, a closed record and a no-op", () => {
    expect(() => checkReplyTypeChange({ before, target: { groupKey: "other", replyTypeId: null, systemRole: null }, expectedContextVersion: 2, confirmUnlock: false })).toThrow(ConflictError);
    expect(() => checkReplyTypeChange({ before: { ...before, workflowState: "closed" }, target: { groupKey: "other", replyTypeId: null, systemRole: null }, expectedContextVersion: 3, confirmUnlock: false })).toThrow(/marked done/);
    expect(() => checkReplyTypeChange({ before, target: { groupKey: "interested", replyTypeId: "s1", systemRole: null }, expectedContextVersion: 3, confirmUnlock: false })).toThrow(/already/);
  });

  it("needs a confirmation to take a locked customer out of the group", () => {
    const locked = { ...before, groupKey: "customer", replyTypeId: "c1", replyTypeLocked: true };
    const target = { groupKey: "not_interested", replyTypeId: null, systemRole: null };
    expect(() => checkReplyTypeChange({ before: locked, target, expectedContextVersion: 3, confirmUnlock: false })).toThrow(/locked as Existing customer/);
    expect(checkReplyTypeChange({ before: locked, target, expectedContextVersion: 3, confirmUnlock: true })).toEqual({ replyTypeLocked: false });
  });

  it("rejects an unknown group", () => {
    expect(() => checkReplyTypeChange({ before, target: { groupKey: "won", replyTypeId: null, systemRole: null }, expectedContextVersion: 3, confirmUnlock: false })).toThrow(ValidationError);
  });
});

describe("pipeline settings and instructions", () => {
  it("validates blocks, duplicate ids and the total length", () => {
    expect(parseInstructionBlocks([{ id: "tone", title: " Tone ", content: " Be brief. " }], "Drafting instructions")).toEqual([{ id: "tone", title: "Tone", content: "Be brief." }]);
    expect(() => parseInstructionBlocks([{ id: "a", title: "A", content: "x" }, { id: "a", title: "B", content: "y" }], "Drafting instructions")).toThrow(/repeats/);
    expect(() => parseInstructionBlocks([{ id: "bad id", title: "A", content: "x" }], "Drafting instructions")).toThrow(/id/);
    const big = Array.from({ length: 4 }, (_, i) => ({ id: `b${i}`, title: "T", content: "x".repeat(7000) }));
    expect(() => parseInstructionBlocks(big, "Drafting instructions")).toThrow(/in total/);
  });
});

describe("group then list order", () => {
  it("sorts by the four groups in order, then by sort order, with an unknown group last", () => {
    const types = [
      { key: "x", groupKey: "legacy", sortOrder: 0 },
      { key: "o", groupKey: "other", sortOrder: 0 },
      { key: "c", groupKey: "customer", sortOrder: 5 },
      { key: "i2", groupKey: "interested", sortOrder: 2 },
      { key: "n", groupKey: "not_interested", sortOrder: 0 },
      { key: "i1", groupKey: "interested", sortOrder: 1 },
      { key: "y", groupKey: "gone", sortOrder: -1 },
    ];
    expect([...types].sort(byGroupThenOrder).map((t) => t.key)).toEqual(["i1", "i2", "c", "n", "o", "y", "x"]);
  });
});
