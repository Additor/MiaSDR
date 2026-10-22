import { z } from "zod";
import { getAiModel, setAiModel } from "@/contexts/integrations/application/ai-model";
import { aiModelDeps } from "@/contexts/integrations/infrastructure/composition";
import { withAdmin } from "@/app/_lib/api";

const FORBIDDEN = "Only an owner or admin can choose the AI model.";

/** The AI connection the organization runs on, its model, and the models that connection offers. `?connection=` describes another saved connection. The response never carries a key. */
export const GET = (request: Request) =>
  withAdmin(FORBIDDEN, (actor) => getAiModel(aiModelDeps(), actor, { connection: new URL(request.url).searchParams.get("connection") ?? undefined }));

/** Runs AI on `connection` (default: the current one) with `model` after checking it against the live list. A null model applies the connection's default. */
export const PUT = (request: Request) =>
  withAdmin(FORBIDDEN, async (actor) =>
    setAiModel(aiModelDeps(), actor, z.object({ connection: z.string().max(40).optional(), model: z.string().max(150).nullable() }).parse(await request.json())),
  );
