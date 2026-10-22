import { NotFoundError, ValidationError, type Actor } from "@/shared/errors";
import { CAMPAIGN_FIELDS, MAX_CAMPAIGN_CUSTOM_COLUMNS, type CampaignFieldMapping } from "../domain/campaign-rows";
import { applyVerifiedGate, heldReason, PASSABLE_VERDICTS, verdictOf, verifyColumns, type PassableVerdict, type PushVerdict, type VerifyColumn } from "../domain/verified-push";
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
  /** Push only the rows this verification column marked with one of `allow`. It must check the mapped email column. */
  verifiedBy?: { columnKey: string; allow: PassableVerdict[] };
}

/** The verification column a push may gate on: it must verify an email, and the email it checked must be the one mapped. */
function gateColumn(columns: Parameters<typeof verifyColumns>[0], verifiedBy: NonNullable<PushToCampaignInput["verifiedBy"]>, emailKey: string | undefined): VerifyColumn {
  const column = verifyColumns(columns).find((c) => c.key === verifiedBy.columnKey);
  if (!column) throw new ValidationError("That column does not verify emails.");
  if (!emailKey || column.emailColumnKey !== emailKey) {
    const checked = columns.find((c) => c.key === column.emailColumnKey)?.name;
    throw new ValidationError(`${column.name} checked ${checked ? `the ${checked} column` : "another column"}, not the email you mapped. Map that column as Email, or push without the check.`);
  }
  if (verifiedBy.allow.length === 0 || verifiedBy.allow.some((v) => !(PASSABLE_VERDICTS as readonly string[]).includes(v))) throw new ValidationError("Choose which verdicts may go to the campaign.");
  return column;
}

/** How many of the chosen rows a verification column marked with each verdict, so the push dialog can show what a gate keeps out. */
export async function previewVerifiedPush(deps: Deps, actor: Actor, tableId: string, input: { rowIds: string[]; columnKey: string; emailKey?: string }): Promise<{ rows: number; verdicts: Partial<Record<PushVerdict, number>> }> {
  const org = actor.organizationId;
  const table = await deps.structure.getTable(org, tableId);
  if (!table) throw new NotFoundError("Table not found");
  const rowIds = [...new Set(input.rowIds)];
  if (rowIds.length === 0 || rowIds.length > GRID_LIMITS.campaignRows) throw new ValidationError(`Select between 1 and ${GRID_LIMITS.campaignRows.toLocaleString("en-US")} rows`);
  const columns = await deps.columns.list(org, tableId);
  if (!verifyColumns(columns).some((c) => c.key === input.columnKey)) throw new ValidationError("That column does not verify emails.");
  const rows = await deps.rows.listByIds(org, tableId, rowIds);
  const verdicts: Partial<Record<PushVerdict, number>> = {};
  for (const row of rows) {
    const verdict = verdictOf(row, input.columnKey, input.emailKey);
    verdicts[verdict] = (verdicts[verdict] ?? 0) + 1;
  }
  return { rows: rows.length, verdicts };
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

  // A verification gate keeps out the rows whose verdict is not allowed, before any of them becomes a lead.
  let pushRows = rows;
  const held: Array<{ rowId: string; reason: string }> = [];
  if (input.verifiedBy) {
    const column = gateColumn(columns, input.verifiedBy, fields.email);
    const gate = applyVerifiedGate(rows, column.key, input.verifiedBy.allow, fields.email);
    pushRows = gate.pass;
    for (const h of gate.held) held.push({ rowId: h.row.id, reason: heldReason(h.verdict, column.name) });
    if (pushRows.length === 0) throw new ValidationError("None of the selected rows passed the verification check.", held.slice(0, 50).map((h) => ({ message: `${h.rowId}: ${h.reason}` })));
  }

  const report = await deps.handoff.push({
    organizationId: org,
    userId: actor.userId,
    tableId,
    tableName: table.name,
    target: { campaignId, newCampaignName: newCampaignName?.trim() || undefined },
    fields,
    customColumnKeys: custom,
    rows: pushRows.map((r) => ({ id: r.id, cells: r.cells })),
    columns: columns.map((c) => ({ key: c.key, name: c.name })),
  });
  return { ...report, failures: [...held, ...report.failures] };
}
