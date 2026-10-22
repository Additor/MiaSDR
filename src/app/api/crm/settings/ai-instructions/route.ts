import { z } from "zod";
import { getCrmTaxonomy, updateCrmAiInstructions } from "@/contexts/conversations/application/crm";
import { crmDeps } from "@/contexts/conversations/infrastructure/crm-composition";
import { withActor } from "@/app/_lib/api";

export const GET = () =>
  withActor(async (actor) => {
    const { settings } = await getCrmTaxonomy(crmDeps(), actor);
    return { draftInstructions: settings.draftInstructions, classificationInstructions: settings.classificationInstructions };
  });

export const PUT = (request: Request) =>
  withActor(async (actor) => {
    await updateCrmAiInstructions(crmDeps(), actor, z.object({ draftInstructions: z.unknown().optional(), classificationInstructions: z.unknown().optional() }).parse(await request.json()));
    return { ok: true };
  });
