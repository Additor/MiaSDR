import { z } from "zod";
import { createKnowledge } from "@/contexts/brain/application/brain-items";
import { brainStore } from "@/contexts/brain/infrastructure/composition";
import { BRAIN_KINDS } from "@/contexts/brain/domain/brain-kinds";
import { withAdmin } from "@/app/_lib/api";

export const POST = (request: Request) =>
  withAdmin(
    "Only an owner or admin can change knowledge documents.",
    async (actor) =>
      createKnowledge(
        brainStore,
        actor,
        z.object({ title: z.string(), kind: z.enum(BRAIN_KINDS), content: z.string(), alwaysInclude: z.boolean().default(false), tags: z.array(z.string().max(500)).max(200).optional() }).parse(await request.json()),
      ),
    201,
  );
