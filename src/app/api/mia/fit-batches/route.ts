import { z } from "zod";
import { withActor } from "@/app/_lib/api";
import { startFitCheck } from "@/contexts/mia/application/mia-use-cases";
import { FIT_MAX_PEOPLE } from "@/contexts/mia/domain/mia-run";
import { miaDeps } from "@/contexts/mia/infrastructure/composition";

const NEW_BATCH = z.object({ personIds: z.array(z.string().max(64)).min(1).max(FIT_MAX_PEOPLE) }).strict();

/** Queues a fit check for each lead. 409 `mia_daily_limit` when today's tokens do not cover them all. */
export const POST = (request: Request) =>
  withActor(async (actor) => {
    const body = NEW_BATCH.parse(await request.json());
    return startFitCheck(miaDeps(), actor, body.personIds);
  }, 201);
