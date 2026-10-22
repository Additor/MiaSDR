/**
 * Every place the app asks a language model for something. A new AI feature adds its task here and writes its own
 * prompt and output schema in its own context; the adapters and the resolver stay as they are.
 */
export const AI_TASKS = {
  "reply.classify": { owner: "conversations", maxTokens: 4000 },
  "reply.draft": { owner: "conversations", maxTokens: 8000 },
  "grid.answer": { owner: "grid", maxTokens: 4000 },
  "grid.formula": { owner: "grid", maxTokens: 4000 },
} as const satisfies Record<string, { owner: string; maxTokens: number }>;

export type AiTaskKey = keyof typeof AI_TASKS;
