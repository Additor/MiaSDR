import { z } from "zod";
import { addBrainItem } from "@/contexts/brain/application/brain-items";
import { BRAIN_ITEM_KINDS } from "@/contexts/brain/domain/brain-kinds";
import { brainStore } from "@/contexts/brain/infrastructure/composition";
import { withActor } from "@/app/_lib/api";

const NEW_ITEM = z.object({
  kind: z.enum(BRAIN_ITEM_KINDS as [string, ...string[]]),
  fields: z.record(z.string(), z.unknown()),
  title: z.string().optional(),
  description: z.string().nullable().optional(),
  alwaysInclude: z.boolean().optional(),
  tags: z.array(z.string().max(500)).max(200).optional(),
});

export const POST = (request: Request) => withActor(async (actor) => addBrainItem(brainStore, actor, NEW_ITEM.parse(await request.json()) as Parameters<typeof addBrainItem>[2]), 201);
