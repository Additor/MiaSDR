import { z } from "zod";
import { getAiModel, setAiModel } from "@/contexts/integrations/application/ai-model";
import { aiModelDeps } from "@/contexts/integrations/infrastructure/composition";
import { withAdmin } from "@/shared/api";

const FORBIDDEN = "Only an owner or admin can choose the AI model.";

/** The organization's default Claude model and the models its saved key can use. The response never carries the key. */
export const GET = () => withAdmin(FORBIDDEN, (actor) => getAiModel(aiModelDeps(), actor));

/** Saves the default model after checking it against the live list. A null or empty model clears the choice. */
export const PUT = (request: Request) =>
  withAdmin(FORBIDDEN, async (actor) => setAiModel(aiModelDeps(), actor, z.object({ model: z.string().max(100).nullable() }).parse(await request.json())));
