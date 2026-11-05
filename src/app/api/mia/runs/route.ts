import { z } from "zod";
import { withActor } from "@/app/_lib/api";
import { startBrainFill, startSort } from "@/contexts/mia/application/mia-use-cases";
import { miaDeps } from "@/contexts/mia/infrastructure/composition";

const NEW_RUN = z.discriminatedUnion("capability", [
  z.object({ capability: z.literal("brain_fill_url"), url: z.string().max(2048) }),
  z.object({ capability: z.literal("brain_fill_text"), text: z.string().max(200_000) }),
  z.object({ capability: z.literal("brain_sort"), itemId: z.string() }),
]);

export const POST = (request: Request) =>
  withActor(async (actor) => {
    const body = NEW_RUN.parse(await request.json());
    if (body.capability === "brain_fill_url") return startBrainFill(miaDeps(), actor, { url: body.url });
    if (body.capability === "brain_fill_text") return startBrainFill(miaDeps(), actor, { text: body.text });
    return startSort(miaDeps(), actor, body.itemId);
  }, 201);
