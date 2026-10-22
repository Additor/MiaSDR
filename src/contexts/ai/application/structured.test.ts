import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { GenerateRequest, GenerateResult } from "../domain/generation";
import type { LanguageModel } from "./ports";
import { generateStructured } from "./structured";

function stub(result: Partial<GenerateResult>) {
  const seen: GenerateRequest[] = [];
  const model: LanguageModel = {
    provider: "stub",
    model: "stub-1",
    capabilities: { jsonSchema: "best_effort", promptCache: "none", reportsCost: false },
    async generate(request) {
      seen.push(request);
      return { text: "", stop: "end", usage: { inputTokens: 1, outputTokens: 1 }, ...result };
    },
  };
  return { model, seen };
}

const ask = (model: LanguageModel) =>
  generateStructured(model, {
    task: "reply.classify",
    system: [{ text: "s", cacheable: true }],
    messages: [{ role: "user", content: "u" }],
    schema: { name: "thing", json: { type: "object" }, parse: z.strictObject({ k: z.enum(["a", "b"]) }) },
    shapeError: "Outside the set.",
  });

describe("generateStructured", () => {
  it("asks for the schema with the task's token budget and returns the parsed output", async () => {
    const { model, seen } = stub({ text: '{"k":"a"}' });
    expect(await ask(model)).toEqual({ output: { k: "a" }, usage: { inputTokens: 1, outputTokens: 1 } });
    expect(seen[0]).toMatchObject({ maxTokens: 4000, output: { kind: "json", name: "thing", schema: { type: "object" } } });
  });

  it("checks the answer again, because a provider's schema support can be best effort", async () => {
    await expect(ask(stub({ text: '{"k":"z"}' }).model)).rejects.toMatchObject({ kind: "transient", reason: "shape", message: "Outside the set." });
    await expect(ask(stub({ text: '{"k":"a","send":true}' }).model)).rejects.toMatchObject({ reason: "shape" });
    await expect(ask(stub({ text: "not json" }).model)).rejects.toMatchObject({ kind: "transient", reason: "shape" });
  });

  it("stops on a refusal and retries a cut-off or empty answer", async () => {
    await expect(ask(stub({ stop: "refusal", text: "{}" }).model)).rejects.toMatchObject({ kind: "permanent" });
    await expect(ask(stub({ stop: "max_tokens", text: "{" }).model)).rejects.toMatchObject({ kind: "transient" });
    await expect(ask(stub({ text: "" }).model)).rejects.toMatchObject({ kind: "transient", message: "The model returned no text." });
  });
});
