import type { z } from "zod";
import { AI_TASKS } from "../domain/ai-tasks";
import { AiError } from "../domain/ai-error";
import type { AiUsage, GenerateRequest, JsonSchema } from "../domain/generation";
import type { LanguageModel } from "./ports";

export interface StructuredRequest<T> extends Omit<GenerateRequest, "output" | "maxTokens"> {
  /** Defaults to the task's budget in `AI_TASKS`. */
  maxTokens?: number;
  schema: { name: string; json: JsonSchema; parse: z.ZodType<T> };
  /** What the error says when the answer parses as JSON but not as `schema.parse`. */
  shapeError: string;
}

/**
 * Asks for JSON that fits `schema.json`, then checks it again with `schema.parse`, because a provider with best-effort
 * schema support can still answer outside it. Every failure is an `AiError` the job runner knows how to retry or stop.
 */
export async function generateStructured<T>(model: LanguageModel, request: StructuredRequest<T>): Promise<{ output: T; usage: AiUsage }> {
  const { schema, shapeError, maxTokens, ...rest } = request;
  const result = await model.generate({
    ...rest,
    maxTokens: maxTokens ?? AI_TASKS[request.task].maxTokens,
    output: { kind: "json", name: schema.name, schema: schema.json },
  });
  if (result.stop === "refusal") throw new AiError("The model declined to answer this message.", "permanent");
  if (result.stop === "max_tokens") throw new AiError("The model's answer was cut off.", "transient");
  if (!result.text) throw new AiError("The model returned no text.", "transient");
  let data: unknown;
  try {
    data = JSON.parse(result.text);
  } catch {
    throw new AiError("The model's answer was not valid JSON.", "transient", "shape");
  }
  const parsed = schema.parse.safeParse(data);
  if (!parsed.success) throw new AiError(shapeError, "transient", "shape");
  return { output: parsed.data, usage: result.usage };
}
