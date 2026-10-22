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
  /** Whether AI is on, without decrypting the key or building a client. */
  isConfigured(organizationId: string): Promise<boolean>;
}

/** A resolver whose `isConfigured` asks `forOrganization`, for fakes where building the AI costs nothing. */
export const replyAiResolverOf = (forOrganization: ReplyAiResolver["forOrganization"]): ReplyAiResolver => ({
  forOrganization,
  isConfigured: async (organizationId) => (await forOrganization(organizationId)) !== null,
});
