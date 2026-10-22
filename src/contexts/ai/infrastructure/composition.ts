import { env } from "@/shared/env";
import type { LanguageModelResolver } from "../application/ports";
import { createModelResolver } from "./drizzle-model-resolver";

/** AI_PROVIDER=fake (demos and tests): each feature answers with its own fake and asks no model. */
export const aiFakeMode = (): boolean => env().AI_PROVIDER === "fake";

/** The organization's configured language model, for every AI feature. */
export const languageModels: LanguageModelResolver = {
  forOrganization: (organizationId) => createModelResolver({ envModel: env().AI_MODEL }).forOrganization(organizationId),
};
