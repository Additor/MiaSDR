import { z } from "zod";
import { moveRecordStage } from "@/contexts/conversations/application/reply-handling";
import { replyHandlingDeps } from "@/contexts/conversations/infrastructure/reply-handling-composition";
import { withActor } from "@/app/_lib/api";

const schema = z.object({
  categoryKey: z.string().min(1).max(40),
  subcategoryId: z.string().uuid().nullable(),
  expectedContextVersion: z.number().int().min(0),
  confirmUnlock: z.boolean().optional(),
  note: z.string().max(4000).nullable().optional(),
  occurredAt: z.string().datetime().nullable().optional(),
});

/** A person moves the record to another stage. Needs the context version the person saw. */
export async function POST(request: Request, ctx: RouteContext<"/api/records/[id]/stage">) {
  const { id } = await ctx.params;
  return withActor(async (actor) => {
    const { occurredAt, ...body } = schema.parse(await request.json());
    return moveRecordStage(replyHandlingDeps(), actor, id, { ...body, occurredAt: occurredAt ? new Date(occurredAt) : null });
  });
}
