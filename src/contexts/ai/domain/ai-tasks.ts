/**
 * Every place the app asks a language model for something. A new AI feature adds its task here and writes its own
 * prompt and output schema in its own context; the adapters and the resolver stay as they are.
 */
export const AI_TASKS = {
  "reply.classify": { maxTokens: 4000 },
  "reply.draft": { maxTokens: 8000 },
  "grid.answer": { maxTokens: 4000 },
  "grid.formula": { maxTokens: 4000 },
} as const satisfies Record<string, { maxTokens: number }>;

export type AiTaskKey = keyof typeof AI_TASKS;
