import { pushToCampaign } from "@/contexts/grid/application/campaign-handoff";
import { GRID_LIMITS } from "@/contexts/grid/application/limits";
import { CAMPAIGN_FIELDS, type CampaignFieldMapping } from "@/contexts/grid/domain/campaign-rows";
import { gridDeps } from "@/contexts/grid/infrastructure/composition";
import { ValidationError } from "@/shared/errors";
import { withActor } from "@/app/_lib/api";
import { idField, idList, idParam, readJsonObject, stringList } from "../../../http";

/**
 * Body `{ rowIds, campaignId | newCampaignName, fields, customColumnKeys? }`. `fields` maps lead fields
 * (email, linkedin, firstName, lastName, fullName, title, phone, companyName, companyDomain) to column keys.
 * Pushes the rows as leads and enrolls them. Suppressed, do-not-contact and already enrolled rows are skipped
 * and listed in `failures`. Nothing is sent.
 */
export async function POST(request: Request, ctx: RouteContext<"/api/grid/tables/[tableId]/campaigns">) {
  const { tableId } = await ctx.params;
  return withActor(async (actor) => {
    const id = idParam(tableId);
    const body = await readJsonObject(request, GRID_LIMITS.cellsBodyBytes);
    const fieldsRaw = body.fields;
    if (typeof fieldsRaw !== "object" || fieldsRaw === null || Array.isArray(fieldsRaw)) throw new ValidationError("fields must be an object");
    const fields: CampaignFieldMapping = {};
    for (const [name, key] of Object.entries(fieldsRaw)) {
      if (!(CAMPAIGN_FIELDS as readonly string[]).includes(name)) throw new ValidationError(`Unknown lead field "${name}"`);
      if (typeof key !== "string") throw new ValidationError(`fields.${name} must be a column key`);
      fields[name as keyof CampaignFieldMapping] = key;
    }
    if (body.newCampaignName !== undefined && typeof body.newCampaignName !== "string") throw new ValidationError("newCampaignName must be text");
    return pushToCampaign(gridDeps(), actor, id, {
      rowIds: idList(body.rowIds, "rowIds", GRID_LIMITS.campaignRows),
      target: { campaignId: body.campaignId === undefined || body.campaignId === null ? undefined : idField(body.campaignId, "campaignId"), newCampaignName: body.newCampaignName as string | undefined },
      fields,
      customColumnKeys: body.customColumnKeys === undefined ? undefined : stringList(body.customColumnKeys, "customColumnKeys", 20),
    });
  }, 201);
}
