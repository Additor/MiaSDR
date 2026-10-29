import { ConflictError, NotFoundError, ValidationError, type Actor } from "@/shared/errors";
import { isOwnerOrAdmin } from "@/contexts/tenancy/domain/roles";
import type { DbHandle } from "@/platform/db/client";
import { retryOnce, sqlState } from "@/platform/db/errors";
import { csvLine, UTF8_BOM } from "@/shared/csv";
import { canonicalProfileUrl } from "../domain/linkedin-url";
import { isFilterActive } from "../domain/lead-filter";
import { planLeadEdit, type LeadEditInput } from "../domain/lead-edit";
import { leadDeleteBlock } from "../domain/person-delete-policy";
import type { BlockedLead, BlockReason, DeleteOutcome, LeadDeleteDeps, LeadDeps, LeadDetail, LeadFilter, LeadForDelete, SendViewer } from "./lead-ports";

/*
 * Permissions: any member of the organization can read, edit, delete and export
 * leads, the same as importing them. Cross-organization ids answer NotFound.
 */

export const MAX_DELETE_IDS = 5000;

export const BLOCK_MESSAGES: Record<BlockReason, string> = {
  has_sends: "Messages were already sent to this lead. Mark it do not contact instead of deleting it.",
  has_hidden_sends: "This lead got messages in another member's personal campaign. Mark it do not contact instead of deleting it.",
  in_active_campaign: "The lead is still in a running or paused campaign. Cancel its enrollment or finish the campaign first.",
  personal_campaign_sends: "The lead is in another member's personal campaign. Ask its creator, an owner or an admin to delete it, or mark it do not contact.",
  linked_records: "The lead has history, such as replies or conversations. Mark it do not contact instead of deleting it.",
  try_again: "Another change to this lead was in progress. Try the delete again in a moment.",
};

/** One line per reason in a bulk delete's answer, for `n` leads kept. Each says why, in the order of the per-lead reasons. */
const KEPT_LINES: Record<BlockReason, (n: number) => string> = {
  has_sends: (n) => `${leads(n)} already got messages.`,
  has_hidden_sends: (n) => `${leads(n)} got messages in another member's personal campaign.`,
  in_active_campaign: (n) => `${leads(n)} ${n === 1 ? "is" : "are"} in a running or paused campaign. Cancel the enrollment or finish the campaign first.`,
  linked_records: (n) => `${leads(n)} ${n === 1 ? "has" : "have"} history, such as replies or conversations.`,
  personal_campaign_sends: (n) => `${leads(n)} ${n === 1 ? "is" : "are"} in another member's personal campaign. Ask its creator, an owner or an admin.`,
  try_again: (n) => `${leads(n)} ${n === 1 ? "was" : "were"} busy with another change. Try again.`,
};
const leads = (n: number) => `${n} ${n === 1 ? "lead" : "leads"}`;

/** Kept leads that only waited on a concurrent change: a second delete can remove them. */
const RETRYABLE: readonly BlockReason[] = ["try_again"];

export interface DeleteSummary {
  deleted: number;
  /** Every kept lead, counted by reason, with the line a person reads. */
  kept: Array<{ reason: BlockReason; count: number; line: string }>;
  /** The kept leads a second delete can remove, at most MAX_DELETE_IDS, so a retry fits one selection. */
  retryIds: string[];
  /** Whether marking the kept leads do not contact stops their outreach: true when one stays for its history. */
  suggestDoNotContact: boolean;
}

/** A bulk delete's outcome as the person reads it: a count and a line per reason, and what they can do next. */
export function summarizeDelete(outcome: DeleteOutcome): DeleteSummary {
  const counts = new Map<BlockReason, number>();
  for (const lead of outcome.blocked) counts.set(lead.reason, (counts.get(lead.reason) ?? 0) + 1);
  const kept = (Object.keys(KEPT_LINES) as BlockReason[]).filter((reason) => counts.has(reason)).map((reason) => ({ reason, count: counts.get(reason)!, line: KEPT_LINES[reason](counts.get(reason)!) }));
  return {
    deleted: outcome.deleted,
    kept,
    retryIds: outcome.blocked.filter((lead) => RETRYABLE.includes(lead.reason)).map((lead) => lead.id).slice(0, MAX_DELETE_IDS),
    suggestDoNotContact: kept.some((k) => !RETRYABLE.includes(k.reason)),
  };
}

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

/** People per delete transaction. Each batch takes its locks, checks and deletes on its own, so one busy lead holds back 499 others at most. */
export const LEAD_DELETE_BATCH = 500;

/** The statement timeout of one batch. A batch past it rolls back and its leads come back as `try_again`. */
export const LEAD_DELETE_STATEMENT_TIMEOUT = "30s";

/**
 * Deletes leads that never had mail sent, are not in a running campaign and have
 * no CRM records. The rest stay and come back in `blocked` with a reason.
 * A filter delete needs the count the person confirmed, so a changed list is not deleted blind,
 * and it refuses an empty filter: "delete all matching" never means "delete everything".
 */
export async function deleteLeads(deps: LeadDeleteDeps, actor: Actor, selection: DeleteSelection): Promise<DeleteOutcome> {
  if ("ids" in selection) {
    const ids = [...new Set(selection.ids)];
    if (ids.length === 0) throw new ValidationError("Select at least one lead.");
    if (ids.length > MAX_DELETE_IDS) throw new ValidationError(`Select up to ${MAX_DELETE_IDS} leads at a time, or delete by filter.`);
    return deleteInBatches(deps, actor, ids);
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
  return deleteInBatches(deps, actor, await deps.people.idsMatching(actor.organizationId, filter));
}

/**
 * The reason a lead stays, from the facts of the three contexts. The viewer only picks between `has_sends` and
 * `has_hidden_sends`, and opens `personal_campaign_sends` to the campaign's creator, an owner or an admin.
 */
async function verdicts(deps: LeadDeleteDeps, tx: DbHandle, actor: Actor, rows: LeadForDelete[]): Promise<Map<string, BlockReason>> {
  const ids = rows.map((row) => row.id);
  const outreach = await deps.outreach.blockers(tx, actor, ids);
  const history = await deps.handling.peopleWithHistory(tx, actor.organizationId, ids);
  const blocked = new Map<string, BlockReason>();
  for (const row of rows) {
    const reason = leadDeleteBlock({ contact: row.contact, history: history.has(row.id), outreach: outreach.get(row.id) ?? [] });
    if (reason) blocked.set(row.id, reason);
  }
  return blocked;
}

/**
 * One batch in one transaction, in the lock order of "Delete" in docs/decisions.md: the people's outreach advisory locks,
 * then the people rows, then their enrollments, each in id order, then the checks, the purge and the delete. The advisory
 * lock comes first because the reply stop takes it before the enrollments and the events it writes; the enrollment locks
 * keep a send claim (`FOR UPDATE SKIP LOCKED`) off these enrollments until the batch commits.
 */
function deleteBatch(deps: LeadDeleteDeps, actor: Actor, ids: string[]): Promise<DeleteOutcome> {
  const organizationId = actor.organizationId;
  return retryOnce(() =>
    deps.transaction(async (tx) => {
      await deps.people.limitStatements(tx);
      const rows = await deps.people.lock(tx, organizationId, ids);
      if (rows.length === 0) return { deleted: 0, blocked: [] };
      await deps.outreach.lockEnrollments(tx, organizationId, rows.map((row) => row.id));
      const blocked = await verdicts(deps, tx, actor, rows);
      const outcome: DeleteOutcome = { deleted: 0, blocked: rows.flatMap((row) => blockedLead(row, blocked.get(row.id))) };
      const deletable = rows.filter((row) => !blocked.has(row.id)).map((row) => row.id);
      if (deletable.length === 0) return outcome;
      await deps.people.keepSuppressed(tx, organizationId, deletable);
      await deps.outreach.purge(tx, organizationId, deletable);
      outcome.deleted = await deps.people.deletePeople(tx, organizationId, deletable);
      return outcome;
    }),
  );
}

const blockedLead = (row: LeadForDelete, reason: BlockReason | undefined): BlockedLead[] => (reason ? [{ id: row.id, name: row.name, reason }] : []);

/** A lock error twice (`try_again`) or the statement timeout (57014): the batch rolled back. */
const isBusy = (error: unknown) => (error instanceof ConflictError && error.details?.code === "try_again") || sqlState(error) === "57014";

/** The people of a run that rolled back, with the reason they stay. */
async function stayed(deps: LeadDeleteDeps, organizationId: string, ids: string[], reason: "try_again" | "linked_records"): Promise<BlockedLead[]> {
  const rows = await deps.transaction((tx) => deps.people.read(tx, organizationId, ids));
  return rows.map((row) => ({ id: row.id, name: row.name, reason }));
}

async function deleteInBatches(deps: LeadDeleteDeps, actor: Actor, ids: string[]): Promise<DeleteOutcome> {
  const outcome: DeleteOutcome = { deleted: 0, blocked: [] };
  const add = (part: DeleteOutcome) => {
    outcome.deleted += part.deleted;
    outcome.blocked.push(...part.blocked);
  };
  /** A run of one lead that rolled back: busy is `try_again`, a foreign key violation `linked_records`. */
  const keep = async (id: string, error: unknown) => {
    if (isBusy(error)) add({ deleted: 0, blocked: await stayed(deps, actor.organizationId, [id], "try_again") });
    else if (sqlState(error) === "23503") add({ deleted: 0, blocked: await stayed(deps, actor.organizationId, [id], "linked_records") });
    else throw error;
  };
  for (let i = 0; i < ids.length; i += LEAD_DELETE_BATCH) {
    const part = ids.slice(i, i + LEAD_DELETE_BATCH);
    try {
      add(await deleteBatch(deps, actor, part));
    } catch (error) {
      if (!isBusy(error) && sqlState(error) !== "23503") throw error;
      // A batch of one lead already ran alone: a second run would only repeat its waits.
      if (part.length === 1) {
        await keep(part[0], error);
        continue;
      }
      // A busy batch (one held row, a lock timeout twice, the statement timeout) or a foreign key violation runs again one
      // lead at a time, so the others still go. A 23503 is the last guard: before the batch held its locks, a send claim or
      // a new record could commit between the checks and the delete; under the locks no known writer can, so it catches
      // only a reference no check covers, and the lead stays as `linked_records`. A lead still busy alone is `try_again`.
      for (const id of part) {
        try {
          add(await deleteBatch(deps, actor, [id]));
        } catch (single) {
          await keep(id, single);
        }
      }
    }
  }
  return outcome;
}

/** The rule that stops this lead from being deleted, or null when it qualifies. The rules of the delete, read without its locks. */
export async function leadDeleteBlockOf(deps: LeadDeleteDeps, actor: Actor, id: string): Promise<BlockReason | null> {
  return deps.transaction(async (tx) => {
    const rows = await deps.people.read(tx, actor.organizationId, [id]);
    if (rows.length === 0) return null;
    return (await verdicts(deps, tx, actor, rows)).get(id) ?? null;
  });
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
