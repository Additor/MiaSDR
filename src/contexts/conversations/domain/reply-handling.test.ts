import { describe, expect, it } from "vitest";
import { ConflictError, ValidationError } from "@/shared/errors";
import { checkReplyTypeChange, keyFromName, parseInstructionBlocks, parseReplyHandlingSettings, parseReplyTypeInput, parseReplyTypePatch } from "./reply-handling";

const before = { groupKey: "interested", replyTypeId: "s1", replyTypeLocked: false, contextVersion: 3, workflowState: "waiting" };

describe("stage move rules", () => {
  it("accepts a move to another subcategory and locks only customers", () => {
    expect(checkReplyTypeChange({ before, target: { groupKey: "interested", replyTypeId: "s2" }, expectedContextVersion: 3, confirmUnlock: false })).toEqual({ replyTypeLocked: false });
    expect(checkReplyTypeChange({ before, target: { groupKey: "customer", replyTypeId: "c1" }, expectedContextVersion: 3, confirmUnlock: false })).toEqual({ replyTypeLocked: true });
  });

  it("rejects a stale version, a closed record and a no-op", () => {
    expect(() => checkReplyTypeChange({ before, target: { groupKey: "other", replyTypeId: null }, expectedContextVersion: 2, confirmUnlock: false })).toThrow(ConflictError);
    expect(() => checkReplyTypeChange({ before: { ...before, workflowState: "closed" }, target: { groupKey: "other", replyTypeId: null }, expectedContextVersion: 3, confirmUnlock: false })).toThrow(/closed/);
    expect(() => checkReplyTypeChange({ before, target: { groupKey: "interested", replyTypeId: "s1" }, expectedContextVersion: 3, confirmUnlock: false })).toThrow(/already/);
  });

  it("needs a confirmation to take a locked customer out of the category", () => {
    const locked = { ...before, groupKey: "customer", replyTypeId: "c1", replyTypeLocked: true };
    const target = { groupKey: "not_interested", replyTypeId: null };
    expect(() => checkReplyTypeChange({ before: locked, target, expectedContextVersion: 3, confirmUnlock: false })).toThrow(/locked as Existing customer/);
    expect(checkReplyTypeChange({ before: locked, target, expectedContextVersion: 3, confirmUnlock: true })).toEqual({ replyTypeLocked: false });
  });

  it("rejects an unknown category", () => {
    expect(() => checkReplyTypeChange({ before, target: { groupKey: "won", replyTypeId: null }, expectedContextVersion: 3, confirmUnlock: false })).toThrow(ValidationError);
  });
});

describe("subcategory input", () => {
  it("derives the key from the name and trims text", () => {
    expect(keyFromName("  Pricing & Plans! ")).toBe("pricing_plans");
    const parsed = parseReplyTypeInput({ groupKey: "interested", name: " Pricing question ", description: " asks for a price ", stageRank: 2, reviewRequired: true });
    expect(parsed).toMatchObject({ key: "pricing_question", name: "Pricing question", description: "asks for a price", stageRank: 2, reviewRequired: true, classificationGuidance: null });
  });

  it("rejects a bad category, key, rank and long guidance", () => {
    expect(() => parseReplyTypeInput({ groupKey: "won", name: "X" })).toThrow(/four categories/);
    expect(() => parseReplyTypeInput({ groupKey: "other", name: "X", key: "Bad Key" })).toThrow(/key/);
    expect(() => parseReplyTypeInput({ groupKey: "other", name: "X", stageRank: 0 })).toThrow(/position/);
    expect(() => parseReplyTypeInput({ groupKey: "other", name: "X", classificationGuidance: "x".repeat(2001) })).toThrow(/guidance/);
  });

  it("builds a patch from the fields present and rejects an empty one", () => {
    expect(parseReplyTypePatch({ active: false, stageRank: null })).toEqual({ active: false, stageRank: null });
    expect(() => parseReplyTypePatch({})).toThrow(/Nothing/);
  });
});

describe("pipeline settings and instructions", () => {
  it("bounds the auto-apply threshold", () => {
    expect(parseReplyHandlingSettings({ autoApplyConfidence: 0.9 })).toEqual({ autoApplyConfidence: 0.9 });
    expect(() => parseReplyHandlingSettings({ autoApplyConfidence: 1.2 })).toThrow();
    expect(() => parseReplyHandlingSettings({ reviewOther: "yes" })).toThrow();
  });

  it("validates blocks, duplicate ids and the total length", () => {
    expect(parseInstructionBlocks([{ id: "tone", title: " Tone ", content: " Be brief. " }], "Drafting instructions")).toEqual([{ id: "tone", title: "Tone", content: "Be brief." }]);
    expect(() => parseInstructionBlocks([{ id: "a", title: "A", content: "x" }, { id: "a", title: "B", content: "y" }], "Drafting instructions")).toThrow(/repeats/);
    expect(() => parseInstructionBlocks([{ id: "bad id", title: "A", content: "x" }], "Drafting instructions")).toThrow(/id/);
    const big = Array.from({ length: 4 }, (_, i) => ({ id: `b${i}`, title: "T", content: "x".repeat(7000) }));
    expect(() => parseInstructionBlocks(big, "Drafting instructions")).toThrow(/in total/);
  });
});
