import { ConflictError, NotFoundError, ValidationError, type Actor } from "@/shared/errors";
import { isOwnerOrAdmin } from "@/contexts/tenancy/domain/roles";
import { csvLine, UTF8_BOM } from "../domain/csv-export";
import { canonicalProfileUrl } from "../domain/linkedin-url";
import { isFilterActive } from "../domain/lead-filter";
import { planLeadEdit, type LeadEditInput } from "../domain/lead-edit";
import type { BlockReason, DeleteOutcome, LeadDeps, LeadDetail, LeadFilter, SendViewer } from "./lead-ports";

/*
 * Permissions: any member of the organization can read, edit, delete and export
 * leads, the same as importing them. Cross-organization ids answer NotFound.
 */

export const MAX_DELETE_IDS = 5000;

export const BLOCK_MESSAGES: Record<BlockReason, string> = {
  has_sends: "Messages were already sent to this lead. Mark it do not contact instead of deleting it.",
  has_hidden_sends: "This lead got messages in another member's personal campaign. Mark it do not contact instead of deleting it.",
  in_active_campaign: "The lead is still in a running or paused campaign. Cancel its enrollment or finish the campaign first.",
  linked_records: "The lead has history, such as replies or conversations. Mark it do not contact instead of deleting it.",
};

/** The actor as a reader of personal-campaign sends: the campaign's creator, an owner or an admin sees them. */
export const sendViewer = (actor: Pick<Actor, "userId" | "role">): SendViewer => ({ userId: actor.userId, seesAllPersonal: isOwnerOrAdmin(actor.role) });

export async function getLead(deps: LeadDeps, actor: Actor, id: string): Promise<LeadDetail> {
  const lead = await deps.leads.get(actor.organizationId, id, sendViewer(actor));
  if (!lead) throw new NotFoundError("Lead not found");
  return lead;
}

export async function updateLead(deps: LeadDeps, actor: Actor, id: string, input: LeadEditInput): Promise<void> {
  // A country sent with the edit wins; otherwise the organization's default reads local-format numbers.
  const defaultCountry = input.phone && !input.defaultCountry ? await deps.defaultPhoneCountry?.(actor.organizationId) : input.defaultCountry;
  await deps.leads.update(
    actor.organizationId,
    id,
    (current) => {
      const plan = planLeadEdit(current, { ...input, defaultCountry });
      if (plan.issues.length > 0) {
        throw new ValidationError(plan.issues[0], plan.issues.map((message) => ({ message })));
      }
      return plan;
    },
    // Restoring an archived column is an owner or admin action, also when an edit names it.
    { restoreArchived: isOwnerOrAdmin(actor.role) },
  );
}

export const MAX_RAW_KEY_CHARS = 100;

/**
 * "Map this field": makes a source-data key a custom field and fills it from
 * the raw data of every lead that has the key. The raw key stays. Leads that
 * already have a value keep it unless `overwrite` is set, so a second run
 * changes nothing.
 */
export async function mapRawField(
  deps: LeadDeps,
  actor: Actor,
  input: { rawKey: string; name: string; overwrite?: boolean },
): Promise<{ key: string; name: string; updated: number }> {
  const rawKey = input.rawKey.trim();
  const name = input.name.trim();
  if (!rawKey || rawKey.length > MAX_RAW_KEY_CHARS) throw new ValidationError("Choose a source data field.");
  if (!name || name.length > MAX_RAW_KEY_CHARS) throw new ValidationError(`Name the field in ${MAX_RAW_KEY_CHARS} characters or fewer.`);
  const column = await deps.leads.ensureCustomColumn(actor.organizationId, name, { restoreArchived: isOwnerOrAdmin(actor.role) });
  const updated = await deps.leads.mapRawToCustom(actor.organizationId, { rawKey, customKey: column.key, overwrite: input.overwrite === true });
  return { ...column, updated };
}

export type DeleteSelection = { ids: string[] } | { filter: LeadFilter; confirmCount: number };

/**
 * Deletes leads that never had mail sent, are not in a running campaign and have
 * no CRM records. The rest stay and come back in `blocked` with a reason.
 * A filter delete needs the count the person confirmed, so a changed list is not deleted blind,
 * and it refuses an empty filter: "delete all matching" never means "delete everything".
 */
export async function deleteLeads(deps: LeadDeps, actor: Actor, selection: DeleteSelection): Promise<DeleteOutcome> {
  if ("ids" in selection) {
    const ids = [...new Set(selection.ids)];
    if (ids.length === 0) throw new ValidationError("Select at least one lead.");
    if (ids.length > MAX_DELETE_IDS) throw new ValidationError(`Select up to ${MAX_DELETE_IDS} leads at a time, or delete by filter.`);
    return deps.leads.deleteByIds(actor.organizationId, ids, sendViewer(actor));
  }
  // Ids belong to the other branch; a filter delete scopes by the filter alone.
  const filter: LeadFilter = { ...selection.filter, ids: undefined };
  // Delete all matching is offered for leads only: a contact has history and is never deleted in bulk.
  if (filter.lifecycle !== undefined && filter.lifecycle !== "lead") throw new ValidationError("Delete all matching works on leads only. Switch the list to leads first.");
  if (!isFilterActive(filter)) throw new ValidationError("Search or filter the list first. Delete all matching needs at least one filter.");
  const current = await deps.leads.count(actor.organizationId, filter);
  if (current !== selection.confirmCount) {
    throw new ConflictError(`The list now matches ${current} leads, not ${selection.confirmCount}. Reload the page and confirm again.`);
  }
  if (current === 0) throw new ValidationError("No leads match this filter.");
  return deps.leads.deleteByFilter(actor.organizationId, filter, sendViewer(actor));
}

export function countLeads(deps: LeadDeps, actor: Actor, filter: LeadFilter): Promise<number> {
  return deps.leads.count(actor.organizationId, filter);
}

/** The ids of the leads that match the filter, for a bulk action over every page. `capped` is true when more leads match than `limit`. */
export async function listMatchingLeadIds(deps: LeadDeps, actor: Actor, filter: LeadFilter, limit: number): Promise<{ ids: string[]; capped: boolean }> {
  // One extra row tells whether the filter matches more than the limit, without a second count query.
  const ids = await deps.leads.matchingIds(actor.organizationId, filter, limit + 1);
  return { ids: ids.slice(0, limit), capped: ids.length > limit };
}

/**
 * The CSV as text chunks: BOM and header first, then one chunk per batch of rows. A filter with `ids` (Export selected) exports
 * exactly those people of the organization: the other filter keys and the default lifecycle do not apply, so a contact ticked
 * under `lifecycle=all` is in the file.
 */
export async function* exportLeadsCsv(deps: LeadDeps, actor: Actor, filter: LeadFilter): AsyncGenerator<string> {
  const scope: LeadFilter = filter.ids ? { ids: filter.ids, lifecycle: "all" } : filter;
  const columns = await deps.leads.customColumns(actor.organizationId);
  yield (
    UTF8_BOM +
    csvLine([
      "First name",
      "Last name",
      "Full name",
      "Email",
      "Phone",
      "LinkedIn",
      "Job title",
      "Company",
      "Company domain",
      "Do not contact",
      "Source",
      "Created",
      "Lifecycle",
      "Source data",
      ...columns.map((c) => c.name),
    ])
  );
  for await (const batch of deps.leads.exportBatches(actor.organizationId, scope)) {
    yield batch
      .map((row) =>
        csvLine([
          row.firstName,
          row.lastName,
          row.fullName,
          row.email,
          row.phone,
          row.linkedinUrl ?? (row.linkedinSlug ? canonicalProfileUrl(row.linkedinSlug) : null),
          row.title,
          row.companyName,
          row.companyDomain,
          row.doNotContact ? "yes" : "no",
          row.source,
          row.createdAt,
          row.lifecycle,
          row.raw && Object.keys(row.raw).length > 0 ? JSON.stringify(row.raw) : null,
          ...columns.map((c) => row.custom[c.key] ?? null),
        ]),
      )
      .join("");
  }
}
