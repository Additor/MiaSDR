import { describe, expect, it } from "vitest";
import { ConflictError, ValidationError } from "@/shared/errors";
import { byGroupThenOrder, checkReplyTypeChange, keyFromName, parseInstructionBlocks, parseReplyHandlingSettings, parseReplyTypeInput, parseReplyTypePatch } from "./reply-handling";

const before = { groupKey: "interested", replyTypeId: "s1", replyTypeLocked: false, contextVersion: 3, workflowState: "waiting" };

describe("type change rules", () => {
  it("accepts a change to another type and locks only for the customer role", () => {
    expect(checkReplyTypeChange({ before, target: { groupKey: "interested", replyTypeId: "s2", systemRole: null }, expectedContextVersion: 3, confirmUnlock: false })).toEqual({ replyTypeLocked: false });
    expect(checkReplyTypeChange({ before, target: { groupKey: "customer", replyTypeId: "c1", systemRole: "customer" }, expectedContextVersion: 3, confirmUnlock: false })).toEqual({ replyTypeLocked: true });
    expect(checkReplyTypeChange({ before, target: { groupKey: "customer", replyTypeId: "c2", systemRole: null }, expectedContextVersion: 3, confirmUnlock: false })).toEqual({ replyTypeLocked: false });
  });

  it("keeps the lock for a change inside the locked group", () => {
    const locked = { ...before, groupKey: "customer", replyTypeId: "c1", replyTypeLocked: true };
    expect(checkReplyTypeChange({ before: locked, target: { groupKey: "customer", replyTypeId: "c2", systemRole: null }, expectedContextVersion: 3, confirmUnlock: false })).toEqual({ replyTypeLocked: true });
  });

  it("rejects a stale version, a closed record and a no-op", () => {
    expect(() => checkReplyTypeChange({ before, target: { groupKey: "other", replyTypeId: null, systemRole: null }, expectedContextVersion: 2, confirmUnlock: false })).toThrow(ConflictError);
    expect(() => checkReplyTypeChange({ before: { ...before, workflowState: "closed" }, target: { groupKey: "other", replyTypeId: null, systemRole: null }, expectedContextVersion: 3, confirmUnlock: false })).toThrow(/closed/);
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

describe("reply type input", () => {
  it("derives the key from the name, trims text and takes the default rules for the ones it does not name", () => {
    expect(keyFromName("  Pricing & Plans! ")).toBe("pricing_plans");
    const parsed = parseReplyTypeInput({ groupKey: "interested", name: " Pricing question ", description: " asks for a price ", checkMode: "before" });
    expect(parsed).toEqual({
      groupKey: "interested",
      key: "pricing_question",
      name: "Pricing question",
      description: "asks for a price",
      classificationGuidance: null,
      rules: { checkMode: "before", replyDraft: true, followUps: "continue" },
    });
    expect(parseReplyTypeInput({ groupKey: "other", name: "Bounce", replyDraft: false, followUps: "stop" }).rules).toEqual({ checkMode: "after", replyDraft: false, followUps: "stop" });
  });

  it("rejects a bad group, key, rule and long guidance", () => {
    expect(() => parseReplyTypeInput({ groupKey: "won", name: "X" })).toThrow(/four groups/);
    expect(() => parseReplyTypeInput({ groupKey: "other", name: "X", key: "Bad Key" })).toThrow(/key/);
    expect(() => parseReplyTypeInput({ groupKey: "other", name: "X", checkMode: "later" })).toThrow(/Check/);
    expect(() => parseReplyTypeInput({ groupKey: "other", name: "X", replyDraft: "yes" })).toThrow(/Reply draft/);
    expect(() => parseReplyTypeInput({ groupKey: "other", name: "X", followUps: "pause" })).toThrow(/Follow-ups/);
    expect(() => parseReplyTypeInput({ groupKey: "other", name: "X", classificationGuidance: "x".repeat(2001) })).toThrow(/guidance/);
  });

  it("builds a patch from the fields present, with only the rules it names, and rejects an empty one", () => {
    expect(parseReplyTypePatch({ active: false, followUps: "stop" })).toEqual({ active: false, rules: { followUps: "stop" } });
    expect(parseReplyTypePatch({ name: "Asks" })).toEqual({ name: "Asks" });
    expect(() => parseReplyTypePatch({})).toThrow(/Nothing/);
    expect(() => parseReplyTypePatch({ stageRank: 2, reviewRequired: true })).toThrow(/Nothing/);
  });
});

describe("pipeline settings and instructions", () => {
  it("bounds the confidence floor", () => {
    expect(parseReplyHandlingSettings({ autoApplyConfidence: 0.9 })).toEqual({ autoApplyConfidence: 0.9 });
    expect(() => parseReplyHandlingSettings({ autoApplyConfidence: 1.2 })).toThrow(/confidence floor/);
    expect(() => parseReplyHandlingSettings({ reviewOther: false })).toThrow(/Nothing/);
  });

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
