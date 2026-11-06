import type { LanguageModel, LanguageModelResolver } from "@/contexts/ai/application/ports";
import { generateStructured } from "@/contexts/ai/application/structured";
import { aiFakeMode, languageModels } from "@/contexts/ai/infrastructure/composition";
import { fitJsonSchema, fitOutputSchema, type FitOutput } from "../domain/lead-fit";
import type { LeadFitAssessor, LeadFitAssessorResolver } from "../application/mia-ports";

export function createFitAssessor(model: LanguageModel): LeadFitAssessor {
  return {
    provider: model.provider,
    model: model.model,
    assess: ({ system, prompt }) =>
      generateStructured(model, {
        task: "mia.lead_fit",
        system: [{ text: system }],
        messages: [{ role: "user", content: prompt }],
        schema: { name: "lead_fit", json: fitJsonSchema, parse: fitOutputSchema },
        shapeError: "The model's fit check did not have the expected fields.",
      }),
  };
}

const PROFILE = /<untrusted_profile_[^>]+>\n([\s\S]*?)\n<\/untrusted_profile_/;
const ICP_ID = /ICP \(id ([0-9a-f-]{36})\)/;

/**
 * Demos and tests (`AI_PROVIDER=fake`): a lead whose title names a Head, a VP or a Chief is a fit, another title is a
 * partial, and no title is unknown, without a model.
 */
export const fakeFitAssessor: LeadFitAssessor = {
  provider: "fake",
  model: "fake-mia",
  async assess({ prompt }) {
    const profile = PROFILE.exec(prompt)?.[1] ?? "";
    const title = /^Title: (.*)$/m.exec(profile)?.[0] ?? null;
    const senior = title !== null && /\b(Head|VP|Chief)\b/.test(title);
    const output: FitOutput = {
      icpItemId: ICP_ID.exec(prompt)?.[1] ?? null,
      criteria: [
        title === null
          ? { criterion: "A decision maker", type: "required", result: "unknown", source: null, evidence: null }
          : { criterion: "A decision maker", type: "required", result: senior ? "met" : "not_met", source: "profile", evidence: title },
      ],
      missing: title === null ? ["Their role"] : [],
    };
    return { output, usage: { inputTokens: 800, outputTokens: 120, cacheReadTokens: 0, cacheWriteTokens: 0 } };
  },
};

export function createFitAssessorResolver(models: LanguageModelResolver = languageModels): LeadFitAssessorResolver {
  return {
    async forOrganization(organizationId) {
      if (aiFakeMode()) return fakeFitAssessor;
      const model = await models.forOrganization(organizationId);
      return model ? createFitAssessor(model) : null;
    },
  };
}
