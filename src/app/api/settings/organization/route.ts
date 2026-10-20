import { z } from "zod";
import { getOrganization, updateOrganization } from "@/contexts/tenancy/application/organization-settings";
import { organizationDeps } from "@/contexts/tenancy/infrastructure/organization-composition";
import { withActor, withAdmin } from "@/shared/api";

export const GET = () => withActor((actor) => getOrganization(organizationDeps(), actor));

const bodySchema = z.object({ name: z.string().max(200).optional(), timeZone: z.string().max(100).optional(), unknownSenderAiDailyCap: z.number().optional(), defaultPhoneCountry: z.string().max(10).nullable().optional() }).strict();

export const PATCH = (request: Request) =>
  withAdmin("Only an owner or admin can change organization settings.", async (actor) =>
    updateOrganization(organizationDeps(), actor, bodySchema.parse(await request.json())),
  );
