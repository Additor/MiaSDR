import { describe, expect, it } from "vitest";
import { aiIsOn, aiOffMessage } from "./ai-status";

describe("AI status", () => {
  it("counts demo mode as on, and has no off message for either", () => {
    expect(aiIsOn({ state: "on", provider: "Anthropic", model: "claude-sonnet-5-5" })).toBe(true);
    expect(aiIsOn({ state: "demo" })).toBe(true);
    expect(aiOffMessage({ state: "demo" })).toBeNull();
    expect(aiOffMessage({ state: "on", provider: "Anthropic", model: "m" })).toBeNull();
  });

  it("names the missing step, and asks a member to get an owner or admin", () => {
    expect(aiIsOn({ state: "no_model", provider: "OpenRouter" })).toBe(false);
    expect(aiOffMessage({ state: "no_key" })).toBe("AI is off. Connect an AI provider in Settings, Integrations.");
    expect(aiOffMessage({ state: "no_key" }, "member")).toBe("AI is off. Ask an owner or admin to connect an AI provider.");
    expect(aiOffMessage({ state: "no_model", provider: "OpenRouter" })).toBe("AI is off. OpenRouter needs a model: pick one in Settings, Integrations.");
    expect(aiOffMessage({ state: "no_model", provider: "OpenRouter" }, "member")).toBe("AI is off. OpenRouter needs a model: ask an owner or admin to pick one.");
    expect(aiIsOn({ state: "key_unreadable", provider: "Anthropic" })).toBe(false);
    expect(aiOffMessage({ state: "key_unreadable", provider: "Anthropic" })).toBe("AI is off. The saved Anthropic key cannot be read: save it again in Settings, Integrations.");
  });
});
