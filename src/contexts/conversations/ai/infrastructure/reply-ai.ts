import { randomBytes } from "node:crypto";
import type { LanguageModel } from "@/contexts/ai/application/ports";
import { generateStructured } from "@/contexts/ai/application/structured";
import { usageRecord } from "@/contexts/ai/domain/generation";
import { classificationJsonSchema, classificationSchema, DRAFT_JSON_SCHEMA, draftSchema, LINKEDIN_DRAFT_JSON_SCHEMA, linkedinDraftSchema, type ClassifyInput, type DraftInput } from "../domain/ai-contract";
import { buildClassifyPrompt, buildDraftPrompt } from "../domain/prompts";
import type { ReplyAi } from "../application/ai-ports";

const nonce = () => randomBytes(6).toString("hex");

/**
 * Reply classification and drafts on any language model. The prompts and the closed schemas live here; the model only
 * transports them. The system prompt is the same on every call, so a provider that caches prompts can cache it.
 */
export function createReplyAi(model: LanguageModel): ReplyAi {
  return {
    name: model.provider,
    model: model.model,

    async classify(input: ClassifyInput) {
      const keys = input.taxonomy.map((t) => t.key);
      const prompt = buildClassifyPrompt(input, nonce());
      const { output, usage } = await generateStructured(model, {
        task: "reply.classify",
        system: [{ text: prompt.system, cacheable: true }],
        messages: [{ role: "user", content: prompt.user }],
        schema: { name: "classification", json: classificationJsonSchema(keys), parse: classificationSchema(keys) },
        shapeError: "The model answered outside the allowed categories.",
      });
      return { output, usage: usageRecord(usage) };
    },

    async draft(input: DraftInput) {
      const prompt = buildDraftPrompt(input, nonce());
      const linkedin = input.channel === "linkedin";
      const request = {
        task: "reply.draft" as const,
        system: [{ text: prompt.system, cacheable: true }],
        messages: [{ role: "user" as const, content: prompt.user }],
        shapeError: "The model returned a draft in an unexpected shape.",
      };
      if (linkedin) {
        const { output, usage } = await generateStructured(model, { ...request, schema: { name: "linkedin_draft", json: LINKEDIN_DRAFT_JSON_SCHEMA, parse: linkedinDraftSchema } });
        return { output: { subject: "", bodyText: output.bodyText }, usage: usageRecord(usage) };
      }
      const { output, usage } = await generateStructured(model, { ...request, schema: { name: "draft", json: DRAFT_JSON_SCHEMA, parse: draftSchema } });
      return { output: { subject: output.subject ?? "", bodyText: output.bodyText }, usage: usageRecord(usage) };
    },
  };
}
