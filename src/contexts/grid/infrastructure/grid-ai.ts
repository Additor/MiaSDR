import type { AiStatus } from "@/contexts/integrations/domain/ai-status";
import { randomBytes } from "node:crypto";
import type { LanguageModel, LanguageModelResolver } from "@/contexts/ai/application/ports";
import { generateStructured } from "@/contexts/ai/application/structured";
import { usageRecord } from "@/contexts/ai/domain/generation";
import { aiFakeMode, languageModels } from "@/contexts/ai/infrastructure/composition";
import { answerJsonSchema, answerSchema, buildAnswerPrompt, type AnswerInput, type AnswerOutput } from "../domain/ai-answer";
import { FakeGridAi } from "./fake-grid-ai";

/** The grid's AI question on one model: AI columns and the formula helper both ask it. */
export interface GridAnswerer {
  readonly provider: string;
  readonly model: string;
  answer(input: AnswerInput, task?: "grid.answer" | "grid.formula"): Promise<{ output: AnswerOutput; usage?: Record<string, number> }>;
}

export interface GridAnswererResolver {
  forOrganization(organizationId: string): Promise<GridAnswerer | null>;
  /** Whether AI is on and why not, for the message a null answerer turns into. */
  status(organizationId: string): Promise<AiStatus>;
}

export function createGridAnswerer(model: LanguageModel): GridAnswerer {
  return {
    provider: model.provider,
    model: model.model,
    async answer(input, task = "grid.answer") {
      const prompt = buildAnswerPrompt(input, randomBytes(6).toString("hex"));
      const { output, usage } = await generateStructured(model, {
        task,
        system: [{ text: prompt.system, cacheable: true }],
        messages: [{ role: "user", content: prompt.user }],
        schema: { name: "row_fields", json: answerJsonSchema(input.outputs), parse: answerSchema(input.outputs) },
        shapeError: "The model answered with fields that were not requested.",
      });
      return { output: output as AnswerOutput, usage: usageRecord(usage) };
    },
  };
}

const globalForGridAi = globalThis as unknown as { __miasdrFakeGridAi?: FakeGridAi };

/** AI_PROVIDER=fake answers with fixed samples; otherwise the organization's configured language model. */
export function createGridAnswererResolver(models: LanguageModelResolver = languageModels): GridAnswererResolver {
  return {
    async forOrganization(organizationId) {
      if (aiFakeMode()) return (globalForGridAi.__miasdrFakeGridAi ??= new FakeGridAi());
      const model = await models.forOrganization(organizationId);
      return model ? createGridAnswerer(model) : null;
    },
    status: (organizationId) => models.status(organizationId),
  };
}
