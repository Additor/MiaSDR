import { describe, expect, it } from "vitest";
import { groupModels } from "./model-combobox";

describe("model picker groups", () => {
  it("groups gateway ids by vendor, sorted, after the pinned entries", () => {
    const groups = groupModels(["openai/gpt-6", "anthropic/claude-sonnet-5.5", "openai/gpt-6-mini", "google/gemini-3"], ["__default__", "openai/gpt-6"]);
    expect(groups).toEqual([
      { label: "", items: ["__default__", "openai/gpt-6"] },
      { label: "anthropic", items: ["anthropic/claude-sonnet-5.5"] },
      { label: "google", items: ["google/gemini-3"] },
      { label: "openai", items: ["openai/gpt-6-mini"] },
    ]);
  });

  it("keeps direct Anthropic ids in one group, headed only when pinned entries sit above it", () => {
    expect(groupModels(["claude-sonnet-5-5", "claude-opus-5-5"], [])).toEqual([{ label: "", items: ["claude-sonnet-5-5", "claude-opus-5-5"] }]);
    expect(groupModels(["claude-sonnet-5-5", "claude-opus-5-5"], ["__default__"])).toEqual([
      { label: "", items: ["__default__"] },
      { label: "Other models", items: ["claude-sonnet-5-5", "claude-opus-5-5"] },
    ]);
  });
});
