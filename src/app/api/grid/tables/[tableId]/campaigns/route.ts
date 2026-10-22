import { previewVerifiedPush, pushToCampaign } from "@/contexts/grid/application/campaign-handoff";
import { GRID_LIMITS } from "@/contexts/grid/application/limits";
import { CAMPAIGN_FIELDS, type CampaignFieldMapping } from "@/contexts/grid/domain/campaign-rows";
import { PASSABLE_VERDICTS, type PassableVerdict } from "@/contexts/grid/domain/verified-push";
import { gridDeps } from "@/contexts/grid/infrastructure/composition";
import { ValidationError } from "@/shared/errors";
import { withActor } from "@/app/_lib/api";
import { idField, idList, idParam, readJsonObject, stringList } from "../../../http";

/** `{ columnKey, allow }`: a verification column and the verdicts that may pass it. */
function verifiedBy(raw: unknown): { columnKey: string; allow: PassableVerdict[] } | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) throw new ValidationError("verifiedBy must be an object");
  const { columnKey, allow } = raw as { columnKey?: unknown; allow?: unknown };
  if (typeof columnKey !== "string" || !columnKey) throw new ValidationError("verifiedBy.columnKey must be a column key");
  const verdicts = stringList(allow, "verifiedBy.allow", PASSABLE_VERDICTS.length);
  for (const v of verdicts) if (!(PASSABLE_VERDICTS as readonly string[]).includes(v)) throw new ValidationError(`verifiedBy.allow cannot hold "${v}"`);
  return { columnKey, allow: verdicts as PassableVerdict[] };
}

/**
 * Body `{ rowIds, campaignId | newCampaignName, fields, customColumnKeys?, verifiedBy? }`. `fields` maps lead fields
 * (email, linkedin, firstName, lastName, fullName, title, phone, companyName, companyDomain) to column keys.
 * Pushes the rows as leads and enrolls them. Suppressed, do-not-contact and already enrolled rows are skipped
 * and listed in `failures`, as are rows `verifiedBy` keeps out. Nothing is sent.
 *
 * `{ rowIds, preview: true, verifiedBy: { columnKey } }` pushes nothing and answers how many rows hold each verdict.
 */
export async function POST(request: Request, ctx: RouteContext<"/api/grid/tables/[tableId]/campaigns">) {
  const { tableId } = await ctx.params;
  return withActor(async (actor) => {
    const id = idParam(tableId);
    const body = await readJsonObject(request, GRID_LIMITS.cellsBodyBytes);
    if (body.preview === true) {
      const columnKey = (body.verifiedBy as { columnKey?: unknown } | undefined)?.columnKey;
      if (typeof columnKey !== "string" || !columnKey) throw new ValidationError("verifiedBy.columnKey must be a column key");
      return previewVerifiedPush(gridDeps(), actor, id, { rowIds: idList(body.rowIds, "rowIds", GRID_LIMITS.campaignRows), columnKey });
    }
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
      verifiedBy: verifiedBy(body.verifiedBy),
    });
  }, 201);
}
