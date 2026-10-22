import { csvLine, UTF8_BOM } from "@/contexts/people/domain/csv-export";
import { isOwnerOrAdmin } from "@/contexts/tenancy/domain/roles";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError, type Actor } from "@/shared/errors";
import { DEFAULT_MAX_RESULTS, MAX_SEARCH_RESULTS, clampMaxResults } from "../domain/linkedin-search";
import {
  MAX_BATCH_IDS,
  MAX_BATCH_QUERIES,
  MAX_BATCH_ROWS,
  MAX_REPORTED_REJECTIONS,
  SEARCH_RUNNING_MESSAGE,
  canManageBatch,
  parseAddedUrls,
  parseBatchRows,
  searchUrlKey,
  type RejectedRow,
} from "../domain/linkedin-search-batch";
import type { LinkedInSearchBatchDeps } from "./linkedin-search-ports";

export interface UploadBatchInput {
  name: string;
  filename?: string | null;
  headers: string[];
  rows: Array<Record<string, string>>;
  maxResults?: number;
  campaignId?: string | null;
  accountIds?: string[];
}

export interface UploadBatchReport {
  id: string;
  queued: number;
  /** Rows that repeat an earlier row of the file. */
  duplicatesInFile: number;
  /** Rows whose search is already waiting or running in another batch or search. */
  alreadyQueued: number;
  rejectedCount: number;
  rejected: RejectedRow[];
}

const isUuid = (value: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

/** Creates a batch from an uploaded sheet: every accepted row becomes one search on the normal queue. */
export async function uploadLinkedInSearchBatch(deps: LinkedInSearchBatchDeps, actor: Actor, input: UploadBatchInput): Promise<UploadBatchReport> {
  const name = input.name.trim();
  if (name === "" || name.length > 120) throw new ValidationError("Give the batch a name of up to 120 characters.");
  const maxResults = clampMaxResults(input.maxResults ?? DEFAULT_MAX_RESULTS);
  if (maxResults === null) throw new ValidationError(`The result limit is a whole number from 1 to ${MAX_SEARCH_RESULTS}.`);

  const campaignId = input.campaignId || null;
  if (campaignId) {
    if (!isUuid(campaignId)) throw new NotFoundError("Campaign not found");
    const campaign = await deps.campaigns.get(actor.organizationId, campaignId);
    if (!campaign) throw new NotFoundError("Campaign not found");
    if (campaign.status === "completed") throw new ConflictError("That campaign is completed. Pick another campaign or none.");
  }

  const accountIds = [...new Set(input.accountIds ?? [])];
  if (accountIds.length > 0) {
    const known = new Set(accountIds.every(isUuid) ? await deps.batches.knownAccountIds(actor.organizationId, accountIds) : []);
    if (accountIds.some((id) => !known.has(id))) throw new ValidationError("Pick LinkedIn accounts of this organization.");
  }

  const parsed = parseBatchRows(input.headers, input.rows);
  if (!parsed.ok) throw new ValidationError(parsed.reason);

  const active = new Set((await deps.batches.activeUrls(actor.organizationId)).map(searchUrlKey));
  const fresh = parsed.accepted.filter((row) => !active.has(searchUrlKey(row.url)));
  const alreadyQueued = parsed.accepted.length - fresh.length;

  if (fresh.length === 0) {
    const issues = parsed.rejected.slice(0, MAX_REPORTED_REJECTIONS).map((r) => ({ message: `Row ${r.row}: ${r.reason}` }));
    const why = alreadyQueued > 0 && parsed.rejected.length === 0 ? `All ${alreadyQueued.toLocaleString("en-US")} ${alreadyQueued === 1 ? "search is" : "searches are"} already in the queue.` : `No row has a usable LinkedIn people search (${parsed.rejected.length} refused).`;
    throw new ValidationError(why, issues);
  }

  const id = await deps.batches.createBatch(actor.organizationId, {
    name,
    accountIds,
    maxResults,
    campaignId,
    createdBy: actor.userId,
    sourceFilename: input.filename?.slice(0, 200) || null,
    rowsTotal: input.rows.length,
    rowsRejected: parsed.rejected.length,
    rejections: parsed.rejected.slice(0, MAX_REPORTED_REJECTIONS).map((r) => ({ row: r.row, reason: r.reason })),
    rows: fresh.map((r) => ({ url: r.url, companyName: r.companyName, sourceRow: r.row })),
  });
  return {
    id,
    queued: fresh.length,
    duplicatesInFile: parsed.duplicatesInFile,
    alreadyQueued,
    rejectedCount: parsed.rejected.length,
    rejected: parsed.rejected.slice(0, MAX_REPORTED_REJECTIONS),
  };
}

export async function listLinkedInSearchBatches(deps: LinkedInSearchBatchDeps, actor: Actor) {
  const [batches, accounts] = await Promise.all([deps.batches.list(actor.organizationId), deps.batches.accounts(actor.organizationId)]);
  return { batches, accounts, maxRows: MAX_BATCH_ROWS, defaultMaxResults: DEFAULT_MAX_RESULTS, maxResultsLimit: MAX_SEARCH_RESULTS };
}

export async function getLinkedInSearchBatch(deps: LinkedInSearchBatchDeps, actor: Actor, id: string) {
  const batch = isUuid(id) ? await deps.batches.get(actor.organizationId, id) : null;
  if (!batch) throw new NotFoundError("Batch not found");
  return batch;
}

/** Moves failed searches of the batch back to the queue. Asking again, or asking for ones that no longer failed, moves none. */
export async function rerunFailedSearches(deps: LinkedInSearchBatchDeps, actor: Actor, id: string, ids?: string[]): Promise<{ rerun: number }> {
  await getLinkedInSearchBatch(deps, actor, id);
  const only = ids ? ids.filter(isUuid) : null;
  if (only && only.length === 0) return { rerun: 0 };
  return { rerun: await deps.batches.rerunFailed(actor.organizationId, id, only) };
}

const RESULT_HEADERS = ["company_name", "search_url", "profile_url", "name", "headline", "location", "network_distance", "in_leads"];

/** The batch's stored results as CSV text: UTF-8 BOM first, formula-safe cells, a page of rows per chunk. */
export async function* exportSearchBatchResults(deps: LinkedInSearchBatchDeps, actor: Actor, id: string): AsyncGenerator<string> {
  await getLinkedInSearchBatch(deps, actor, id);
  yield UTF8_BOM + csvLine(RESULT_HEADERS);
  for await (const page of deps.batches.resultPages(actor.organizationId, id, 1000)) {
    yield page.map((r) => csvLine([r.companyName, r.searchUrl, r.profileUrl, r.name, r.headline, r.location, r.networkDistance, r.inLeads ? "yes" : "no"])).join("");
  }
}

export interface AddUrlsReport {
  added: number;
  /** Addresses the batch already holds. */
  alreadyInBatch: number;
  /** Addresses whose search waits or runs in another batch or search. */
  alreadyQueued: number;
  /** Lines that repeat an earlier line of the pasted list. */
  duplicatesInList: number;
  rejectedCount: number;
  rejected: RejectedRow[];
  /** Searches the batch holds now. */
  total: number;
}

/** Adds people searches to a batch that exists. They queue with the batch's result limit and campaign, under the same rules as an upload. */
export async function addSearchBatchUrls(deps: LinkedInSearchBatchDeps, actor: Actor, id: string, urls: string[]): Promise<AddUrlsReport> {
  const batch = await getLinkedInSearchBatch(deps, actor, id);
  // Blank lines at the end of a pasted list are noise; one in the middle is reported with its line number.
  const lines = urls.map((u) => u.trim());
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  if (lines.length === 0) throw new ValidationError("Paste at least one LinkedIn people search URL.");
  if (lines.length > MAX_BATCH_ROWS) throw new ValidationError(`Add up to ${MAX_BATCH_ROWS.toLocaleString("en-US")} URLs at a time.`);
  if (batch.campaign) {
    const campaign = await deps.campaigns.get(actor.organizationId, batch.campaign.id);
    if (campaign?.status === "completed") throw new ConflictError("This batch's campaign is completed, so people from new searches could not be added to it. Start a new batch with another campaign.");
  }
  const parsed = parseAddedUrls(lines);
  if (!parsed.ok) throw new ValidationError(parsed.reason);

  const active = new Set((await deps.batches.activeUrls(actor.organizationId)).map(searchUrlKey));
  const fresh = parsed.accepted.filter((row) => !active.has(searchUrlKey(row.url)));
  const alreadyQueued = parsed.accepted.length - fresh.length;
  const rejected = parsed.rejected.slice(0, MAX_REPORTED_REJECTIONS);
  if (fresh.length === 0) {
    const issues = rejected.map((r) => ({ message: `Line ${r.row}: ${r.reason}` }));
    const why = alreadyQueued > 0 && parsed.rejected.length === 0 ? `All ${alreadyQueued.toLocaleString("en-US")} ${alreadyQueued === 1 ? "search is" : "searches are"} already in the queue.` : `No line is a usable LinkedIn people search (${parsed.rejected.length} refused).`;
    throw new ValidationError(why, issues);
  }

  const result = await deps.batches.addQueries(actor.organizationId, id, fresh.map((r) => ({ url: r.url, companyName: r.companyName })), MAX_BATCH_QUERIES);
  if (result.tooMany) throw new ConflictError(`A batch holds up to ${MAX_BATCH_QUERIES.toLocaleString("en-US")} searches and this one would have ${result.total.toLocaleString("en-US")}. Remove some searches or start another batch.`);
  return { added: result.added, alreadyInBatch: result.alreadyInBatch, alreadyQueued, duplicatesInList: parsed.duplicatesInFile, rejectedCount: parsed.rejected.length, rejected, total: result.total };
}

/** Throws 403 unless the actor is an owner or admin, or created the batch. Returns the batch. */
async function manageable(deps: LinkedInSearchBatchDeps, actor: Actor, id: string) {
  const batch = await getLinkedInSearchBatch(deps, actor, id);
  if (!canManageBatch({ isOwnerOrAdmin: isOwnerOrAdmin(actor.role), actorUserId: actor.userId, createdBy: batch.createdBy })) {
    throw new ForbiddenError("Only an owner, an admin or the person who uploaded this batch can remove its searches or results.");
  }
  return batch;
}

function pickIds(ids: string[] | undefined): string[] | null {
  if (ids === undefined) return null;
  const unique = [...new Set(ids)];
  if (unique.length === 0) throw new ValidationError("Pick at least one search.");
  if (unique.length > MAX_BATCH_IDS) throw new ValidationError(`Pick up to ${MAX_BATCH_IDS.toLocaleString("en-US")} searches at a time.`);
  // An id that is no UUID cannot match a row. It counts as not found.
  return unique.map((x) => (isUuid(x) ? x : "00000000-0000-0000-0000-000000000000"));
}

/** The counts of a finished change, or the 409 when a named search was running. */
function counts<T extends { ok: boolean }>(change: T): Omit<Extract<T, { ok: true }>, "ok"> {
  if (!change.ok) throw new ConflictError(SEARCH_RUNNING_MESSAGE, { running: (change as unknown as { running: number }).running });
  const { ok, ...rest } = change as Extract<T, { ok: true }>;
  void ok;
  return rest;
}

/**
 * Deletes searches and the people they staged. Leads that already exist, their enrollments and sends stay.
 * Refused with 409 while any named search runs, and nothing is deleted then.
 */
export async function removeSearchBatchUrls(deps: LinkedInSearchBatchDeps, actor: Actor, id: string, ids: string[]) {
  await manageable(deps, actor, id);
  return counts(await deps.batches.removeQueries(actor.organizationId, id, pickIds(ids), { actorUserId: actor.userId }));
}

/** Deletes the staged results of the named searches (every search of the batch without `ids`) and keeps the searches. Leads already created stay. */
export async function deleteSearchBatchResults(deps: LinkedInSearchBatchDeps, actor: Actor, id: string, ids?: string[]) {
  await manageable(deps, actor, id);
  return counts(await deps.batches.deleteResults(actor.organizationId, id, pickIds(ids), { actorUserId: actor.userId }));
}

/** Deletes the batch with its searches and staged results. Leads that already exist, their enrollments and sends stay. */
export async function deleteSearchBatch(deps: LinkedInSearchBatchDeps, actor: Actor, id: string) {
  await manageable(deps, actor, id);
  return counts(await deps.batches.deleteBatch(actor.organizationId, id, { actorUserId: actor.userId }));
}

/** Makes paused and queued searches due now. The daily allowance and the pacing between pages of one account still apply. */
export async function runSearchBatch(deps: LinkedInSearchBatchDeps, actor: Actor, id: string, ids?: string[]): Promise<{ queued: number }> {
  await getLinkedInSearchBatch(deps, actor, id);
  return { queued: await deps.batches.runNow(actor.organizationId, id, pickIds(ids)) };
}
