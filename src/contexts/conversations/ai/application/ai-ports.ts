import type { AnswerInput, AnswerOutput, ClassifyInput, ClassifyOutput, DraftInput, DraftOutput } from "../domain/ai-contract";

/**
 * transient: worth another attempt later (rate limit, timeout, malformed answer).
 * permanent: retrying cannot help (bad key, rejected request, content refused).
 */
export class AiError extends Error {
  constructor(
    message: string,
    readonly kind: "transient" | "permanent",
    /** `shape`: the provider answered, but not in the requested form. Retries may help, so it is transient until the attempts run out. */
    readonly reason?: "shape",
  ) {
    super(message);
  }
}

export interface AiProvider {
  readonly name: string;
  readonly model: string;
  /** Returns an answer that already passed `classificationSchema(keys)`. Callers validate again. */
  classify(input: ClassifyInput): Promise<{ output: ClassifyOutput; usage?: Record<string, number> }>;
  draft(input: DraftInput): Promise<{ output: DraftOutput; usage?: Record<string, number> }>;
  /** Fills the requested fields from cell values (grid AI columns). Absent on providers that do not support it. */
  answer?(input: AnswerInput): Promise<{ output: AnswerOutput; usage?: Record<string, number> }>;
}

/** Picks the provider for one organization. Null means AI is not configured there, and the job does nothing. */
export interface AiProviderResolver {
  forOrganization(organizationId: string): Promise<AiProvider | null>;
}
