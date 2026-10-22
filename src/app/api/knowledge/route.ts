import { z } from "zod";
import { createKnowledge, listKnowledge } from "@/contexts/conversations/ai/application/knowledge";
import { knowledgeStore } from "@/contexts/conversations/infrastructure/composition";
import { KNOWLEDGE_KINDS } from "@/contexts/conversations/ai/domain/knowledge";
import { withActor } from "@/app/_lib/api";

export const GET = () => withActor((actor) => listKnowledge(knowledgeStore, actor));

export const POST = (request: Request) =>
  withActor(
    async (actor) =>
      createKnowledge(
        knowledgeStore,
        actor,
        z.object({ title: z.string(), kind: z.enum(KNOWLEDGE_KINDS), content: z.string(), alwaysInclude: z.boolean().default(false), tags: z.array(z.string().max(500)).max(200).optional() }).parse(await request.json()),
      ),
    201,
  );
