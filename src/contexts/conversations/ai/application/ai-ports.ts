import type { ClassifyInput, ClassifyOutput, DraftInput, DraftOutput } from "../domain/ai-contract";

/** Reply handling's AI: classify an inbound reply and draft an answer. Each call returns output that passed the closed schema. */
export interface ReplyAi {
  /** The connection and model, recorded on the job and the draft. */
  readonly name: string;
  readonly model: string;
  /** Returns an answer that already passed `classificationSchema(keys)`. Callers validate again. */
  classify(input: ClassifyInput): Promise<{ output: ClassifyOutput; usage?: Record<string, number> }>;
  draft(input: DraftInput): Promise<{ output: DraftOutput; usage?: Record<string, number> }>;
}

/** Picks the reply AI for one organization. Null means AI is not configured there, and the job does nothing. */
export interface ReplyAiResolver {
  forOrganization(organizationId: string): Promise<ReplyAi | null>;
}
