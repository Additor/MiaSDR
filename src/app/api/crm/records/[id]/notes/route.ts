import { z } from "zod";
import { addCrmNote } from "@/contexts/conversations/application/crm";
import { crmDeps } from "@/contexts/conversations/infrastructure/crm-composition";
import { withActor } from "@/app/_lib/api";

export async function POST(request: Request, ctx: RouteContext<"/api/crm/records/[id]/notes">) {
  const { id } = await ctx.params;
  return withActor(async (actor) => addCrmNote(crmDeps(), actor, id, z.object({ title: z.string().max(200).nullable().optional(), body: z.string().min(1).max(10_000) }).parse(await request.json())), 201);
}
