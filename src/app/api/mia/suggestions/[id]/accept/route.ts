import { z } from "zod";
import { withActor } from "@/app/_lib/api";
import { acceptSuggestion } from "@/contexts/mia/application/mia-use-cases";
import { miaDeps } from "@/contexts/mia/infrastructure/composition";

const ACCEPT = z.object({
  fields: z.record(z.string(), z.unknown()),
  confirmed: z.array(z.string().max(100)).max(50).optional(),
  title: z.string().optional(),
  revision: z.number().int().optional(),
});

export async function POST(request: Request, ctx: RouteContext<"/api/mia/suggestions/[id]/accept">) {
  const { id } = await ctx.params;
  return withActor(async (actor) => acceptSuggestion(miaDeps(), actor, id, ACCEPT.parse(await request.json())));
}
