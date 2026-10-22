import type { AiStatus } from "@/contexts/integrations/domain/ai-status";
import type { GenerateRequest, GenerateResult } from "../domain/generation";

/** One configured model behind one provider connection. Adapters translate to the provider's protocol and back. */
export interface LanguageModel {
  /** The connection key, such as `anthropic` or `openrouter`. */
  readonly provider: string;
  readonly model: string;
  generate(request: GenerateRequest): Promise<GenerateResult>;
}

/** The organization's configured model. Null means AI is not configured there, and the caller does nothing. */
export interface LanguageModelResolver {
  forOrganization(organizationId: string): Promise<LanguageModel | null>;
  /** Whether AI is on and why not, without decrypting the key or building a client. */
  status(organizationId: string): Promise<AiStatus>;
}
