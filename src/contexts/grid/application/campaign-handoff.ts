import { NotFoundError, ValidationError, type Actor } from "@/shared/errors";
import { CAMPAIGN_FIELDS, MAX_CAMPAIGN_CUSTOM_COLUMNS, type CampaignFieldMapping } from "../domain/campaign-rows";
import { GRID_LIMITS } from "./limits";
import type { GridDeps, HandoffTarget } from "./ports";

type Deps = Pick<GridDeps, "structure" | "columns" | "rows" | "handoff">;

export interface PushToCampaignInput {
  rowIds: string[];
  target: HandoffTarget;
  /** Lead field to the grid column key that holds it. Email or LinkedIn is required. */
  fields: CampaignFieldMapping;
  /** Other columns to keep on the lead as custom fields (merge fields for the sequence). */
  customColumnKeys?: string[];
}

/**
 * Pushes selected rows to a campaign as leads. The people context creates or updates the person with its
 * usual validation and de-duplication. Suppressed addresses, do-not-contact people and people already in
 * the campaign are skipped and reported per row. The campaign stays in the state it was in, so nothing is
 * sent: a draft campaign still needs its own review and start.
 */
export async function pushToCampaign(deps: Deps, actor: Actor, tableId: string, input: PushToCampaignInput) {
  const org = actor.organizationId;
  const table = await deps.structure.getTable(org, tableId);
  if (!table) throw new NotFoundError("Table not found");

  const rowIds = [...new Set(input.rowIds)];
  if (rowIds.length === 0 || rowIds.length > GRID_LIMITS.campaignRows) throw new ValidationError(`Select between 1 and ${GRID_LIMITS.campaignRows.toLocaleString("en-US")} rows`);
  const { campaignId, newCampaignName } = input.target;
  if (Boolean(campaignId) === Boolean(newCampaignName?.trim())) throw new ValidationError("Choose an existing campaign or give a name for a new one");
  if (newCampaignName !== undefined && newCampaignName.trim().length > 120) throw new ValidationError("Give the campaign a name of up to 120 characters.");

  const fields: CampaignFieldMapping = {};
  for (const field of CAMPAIGN_FIELDS) {
    const key = input.fields[field];
    if (key !== undefined && key !== "") fields[field] = key;
  }
  if (!fields.email && !fields.linkedin) throw new ValidationError("Map an Email or LinkedIn column");
  const custom = [...new Set(input.customColumnKeys ?? [])];
  if (custom.length > MAX_CAMPAIGN_CUSTOM_COLUMNS) throw new ValidationError(`Keep at most ${MAX_CAMPAIGN_CUSTOM_COLUMNS} extra columns`);

  const columns = await deps.columns.list(org, tableId);
  const known = new Set(columns.map((c) => c.key));
  for (const key of [...Object.values(fields), ...custom]) if (!known.has(key)) throw new ValidationError("The mapping contains a column that no longer exists");

  const rows = await deps.rows.listByIds(org, tableId, rowIds);
  if (rows.length !== rowIds.length) throw new ValidationError("One or more selected rows do not belong to this table");

  return deps.handoff.push({
    organizationId: org,
    userId: actor.userId,
    tableId,
    tableName: table.name,
    target: { campaignId, newCampaignName: newCampaignName?.trim() || undefined },
    fields,
    customColumnKeys: custom,
    rows: rows.map((r) => ({ id: r.id, cells: r.cells })),
    columns: columns.map((c) => ({ key: c.key, name: c.name })),
  });
}
