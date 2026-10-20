import { describe, expect, it } from "vitest";
import { ConflictError, ValidationError } from "@/shared/errors";
import { checkStageMove, keyFromName, parseInstructionBlocks, parsePipelineSettings, parseSubcategoryInput, parseSubcategoryPatch } from "./crm";

const before = { categoryKey: "interested", subcategoryId: "s1", categoryLocked: false, contextVersion: 3, workflowState: "waiting" };

describe("stage move rules", () => {
  it("accepts a move to another subcategory and locks only customers", () => {
    expect(checkStageMove({ before, target: { categoryKey: "interested", subcategoryId: "s2" }, expectedContextVersion: 3, confirmUnlock: false })).toEqual({ categoryLocked: false });
    expect(checkStageMove({ before, target: { categoryKey: "customer", subcategoryId: "c1" }, expectedContextVersion: 3, confirmUnlock: false })).toEqual({ categoryLocked: true });
  });

  it("rejects a stale version, a closed record and a no-op", () => {
    expect(() => checkStageMove({ before, target: { categoryKey: "other", subcategoryId: null }, expectedContextVersion: 2, confirmUnlock: false })).toThrow(ConflictError);
    expect(() => checkStageMove({ before: { ...before, workflowState: "closed" }, target: { categoryKey: "other", subcategoryId: null }, expectedContextVersion: 3, confirmUnlock: false })).toThrow(/closed/);
    expect(() => checkStageMove({ before, target: { categoryKey: "interested", subcategoryId: "s1" }, expectedContextVersion: 3, confirmUnlock: false })).toThrow(/already/);
  });

  it("needs a confirmation to take a locked customer out of the category", () => {
    const locked = { ...before, categoryKey: "customer", subcategoryId: "c1", categoryLocked: true };
    const target = { categoryKey: "not_interested", subcategoryId: null };
    expect(() => checkStageMove({ before: locked, target, expectedContextVersion: 3, confirmUnlock: false })).toThrow(/locked as Existing customer/);
    expect(checkStageMove({ before: locked, target, expectedContextVersion: 3, confirmUnlock: true })).toEqual({ categoryLocked: false });
  });

  it("rejects an unknown category", () => {
    expect(() => checkStageMove({ before, target: { categoryKey: "won", subcategoryId: null }, expectedContextVersion: 3, confirmUnlock: false })).toThrow(ValidationError);
  });
});

describe("subcategory input", () => {
  it("derives the key from the name and trims text", () => {
    expect(keyFromName("  Pricing & Plans! ")).toBe("pricing_plans");
    const parsed = parseSubcategoryInput({ categoryKey: "interested", name: " Pricing question ", description: " asks for a price ", stageRank: 2, reviewRequired: true });
    expect(parsed).toMatchObject({ key: "pricing_question", name: "Pricing question", description: "asks for a price", stageRank: 2, reviewRequired: true, classificationGuidance: null });
  });

  it("rejects a bad category, key, rank and long guidance", () => {
    expect(() => parseSubcategoryInput({ categoryKey: "won", name: "X" })).toThrow(/four categories/);
    expect(() => parseSubcategoryInput({ categoryKey: "other", name: "X", key: "Bad Key" })).toThrow(/key/);
    expect(() => parseSubcategoryInput({ categoryKey: "other", name: "X", stageRank: 0 })).toThrow(/position/);
    expect(() => parseSubcategoryInput({ categoryKey: "other", name: "X", classificationGuidance: "x".repeat(2001) })).toThrow(/guidance/);
  });

  it("builds a patch from the fields present and rejects an empty one", () => {
    expect(parseSubcategoryPatch({ active: false, stageRank: null })).toEqual({ active: false, stageRank: null });
    expect(() => parseSubcategoryPatch({})).toThrow(/Nothing/);
  });
});

describe("pipeline settings and instructions", () => {
  it("bounds the auto-apply threshold", () => {
    expect(parsePipelineSettings({ autoApplyConfidence: 0.9 })).toEqual({ autoApplyConfidence: 0.9 });
    expect(() => parsePipelineSettings({ autoApplyConfidence: 1.2 })).toThrow();
    expect(() => parsePipelineSettings({ reviewOther: "yes" })).toThrow();
  });

  it("validates blocks, duplicate ids and the total length", () => {
    expect(parseInstructionBlocks([{ id: "tone", title: " Tone ", content: " Be brief. " }], "Drafting instructions")).toEqual([{ id: "tone", title: "Tone", content: "Be brief." }]);
    expect(() => parseInstructionBlocks([{ id: "a", title: "A", content: "x" }, { id: "a", title: "B", content: "y" }], "Drafting instructions")).toThrow(/repeats/);
    expect(() => parseInstructionBlocks([{ id: "bad id", title: "A", content: "x" }], "Drafting instructions")).toThrow(/id/);
    const big = Array.from({ length: 4 }, (_, i) => ({ id: `b${i}`, title: "T", content: "x".repeat(7000) }));
    expect(() => parseInstructionBlocks(big, "Drafting instructions")).toThrow(/in total/);
  });
});
