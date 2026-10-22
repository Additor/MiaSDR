import { z } from "zod";
import { getCrmTaxonomy, updateCrmSettings } from "@/contexts/conversations/application/crm";
import { crmDeps } from "@/contexts/conversations/infrastructure/crm-composition";
import { withActor } from "@/app/_lib/api";

export const GET = () => withActor(async (actor) => (await getCrmTaxonomy(crmDeps(), actor)).settings);

/** Auto-apply threshold and the two review switches. */
export const PATCH = (request: Request) =>
  withActor(async (actor) => {
    await updateCrmSettings(crmDeps(), actor, z.record(z.string(), z.unknown()).parse(await request.json()));
    return { ok: true };
  });
