import { z } from "zod";
import { createDealStage, listDealStages } from "@/contexts/deals/application/deal-stages";
import { dealsDeps } from "@/composition/deals";
import { withActor, withAdmin } from "@/app/_lib/api";

/** The pipeline's stages. An organization without stages gets the defaults with `virtual: true`; this never writes. */
export function GET() {
  return withActor((actor) => listDealStages(dealsDeps(), actor));
}

export async function POST(request: Request) {
  return withAdmin("Only an owner or admin can change pipeline stages.", async (actor) => createDealStage(dealsDeps(), actor, z.object({ name: z.string().max(200), kind: z.string().max(10) }).parse(await request.json())), 201);
}
