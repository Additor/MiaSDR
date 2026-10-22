import { describe, expect, it } from "vitest";
import type { LanguageModel } from "@/contexts/ai/application/ports";
import type { GenerateRequest } from "@/contexts/ai/domain/generation";
import type { ClassifyInput, DraftInput } from "../../domain/ai-contract";
import { createReplyAi } from "../reply-ai";

const input: ClassifyInput = {
  taxonomy: [
    { key: "demo_request", name: "Demo request", categoryKey: "interested", description: null, guidance: null },
    { key: "other", name: "Other", categoryKey: "other", description: null, guidance: null },
  ],
  person: { name: "Eve", email: "eve@x.test", title: null, company: null },
  thread: [{ direction: "inbound", at: new Date("2026-10-14T10:00:00Z"), subject: "Hi", text: "SECRET-BODY please book a demo" }],
  operatorInstructions: "",
  businessContext: "",
};
const draftInput = (channel: "email" | "linkedin"): DraftInput => ({ channel, person: input.person, thread: input.thread, subject: "Re: Hi", classification: null, stageChange: null, operatorInstructions: "", knowledge: [], feedback: null, previousDraft: null, senderName: null });

function answering(text: string) {
  const seen: GenerateRequest[] = [];
  const model: LanguageModel = {
    provider: "openrouter",
    model: "openai/gpt-6",
    async generate(request) {
      seen.push(request);
      return { text, stop: "end", usage: { inputTokens: 3, outputTokens: 2, costUsd: 0.001 } };
    },
  };
  return { ai: createReplyAi(model), seen };
}

describe("reply AI on a language model", () => {
  it("classifies with a closed enum of exactly the active keys and a cacheable system prompt", async () => {
    const { ai, seen } = answering(JSON.stringify({ subcategoryKey: "demo_request", confidence: 0.9, reason: "Asks for a demo." }));
    const result = await ai.classify(input);
    expect(result).toEqual({ output: { subcategoryKey: "demo_request", confidence: 0.9, reason: "Asks for a demo." }, usage: { inputTokens: 3, outputTokens: 2, costUsd: 0.001 } });
    expect(ai).toMatchObject({ name: "openrouter", model: "openai/gpt-6" });
    const request = seen[0];
    expect(request.task).toBe("reply.classify");
    expect(request.system).toEqual([{ text: expect.stringContaining("You classify"), cacheable: true }]);
    expect(request.messages[0].content).toContain("SECRET-BODY");
    expect(request.output.schema).toMatchObject({ properties: { subcategoryKey: { enum: ["demo_request", "other"] } }, additionalProperties: false });
  });

  it("rejects an answer outside the closed set or with extra fields", async () => {
    await expect(answering(JSON.stringify({ subcategoryKey: "wire_money", confidence: 1, reason: "x" })).ai.classify(input)).rejects.toMatchObject({ kind: "transient", reason: "shape" });
    await expect(answering(JSON.stringify({ subcategoryKey: "other", confidence: 1, reason: "x", send: true })).ai.classify(input)).rejects.toMatchObject({ reason: "shape" });
  });

  it("drafts email with a subject and validates the shape", async () => {
    const { ai, seen } = answering(JSON.stringify({ subject: "Re: Hi", bodyText: "Hello" }));
    expect((await ai.draft(draftInput("email"))).output).toEqual({ subject: "Re: Hi", bodyText: "Hello" });
    expect(seen[0].task).toBe("reply.draft");
    await expect(answering(JSON.stringify({ subject: "x" })).ai.draft(draftInput("email"))).rejects.toMatchObject({ reason: "shape" });
  });

  it("asks for a body only on LinkedIn and returns no subject", async () => {
    const { ai, seen } = answering(JSON.stringify({ bodyText: "Thursday works.", subject: "stray" }));
    expect((await ai.draft(draftInput("linkedin"))).output).toEqual({ subject: "", bodyText: "Thursday works." });
    const request = seen[0];
    expect(request.output.schema).toMatchObject({ required: ["bodyText"] });
    expect(request.system[0].text).toMatch(/LinkedIn/);
  });
});
