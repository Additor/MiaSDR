import { z } from "zod";
import { createCrmSubcategory, getCrmTaxonomy } from "@/contexts/conversations/application/crm";
import { crmDeps } from "@/contexts/conversations/infrastructure/crm-composition";
import { withActor } from "@/shared/api";

export const GET = () => withActor(async (actor) => (await getCrmTaxonomy(crmDeps(), actor)).subcategories);

export const POST = (request: Request) =>
  withActor(async (actor) => createCrmSubcategory(crmDeps(), actor, z.record(z.string(), z.unknown()).parse(await request.json())), 201);
