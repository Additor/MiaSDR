import { ConflictError, NotFoundError, ValidationError, type Actor } from "@/shared/errors";
import {
  DEFAULT_MAX_RESULTS,
  MAX_SEARCH_RESULTS,
  canApply,
  clampMaxResults,
  normalizeSearchUrl,
  type SearchAction,
} from "../domain/linkedin-search";
import type { LinkedInSearchDeps } from "./linkedin-search-ports";

export interface CreateSearchInput {
  name: string;
  url: string;
  maxResults?: number;
  campaignId?: string | null;
}

export async function createLinkedInSearch(deps: LinkedInSearchDeps, actor: Actor, input: CreateSearchInput): Promise<{ id: string }> {
  const name = input.name.trim();
  if (name === "" || name.length > 120) throw new ValidationError("Give the search a name of up to 120 characters.");
  const url = normalizeSearchUrl(input.url);
  if (!url.ok) throw new ValidationError(url.reason);
  const maxResults = clampMaxResults(input.maxResults);
  if (maxResults === null) throw new ValidationError(`The result limit is a whole number from 1 to ${MAX_SEARCH_RESULTS}.`);

  const campaignId = input.campaignId || null;
  if (campaignId) {
    const campaign = await deps.campaigns.get(actor.organizationId, campaignId);
    if (!campaign) throw new NotFoundError("Campaign not found");
    if (campaign.status === "completed") throw new ConflictError("That campaign is completed. Pick another one or none.");
  }
  return { id: await deps.searches.create(actor.organizationId, { name, url: url.value.url, maxResults, campaignId }) };
}

export async function listLinkedInSearches(deps: LinkedInSearchDeps, actor: Actor) {
  const [searches, batches, connectedAccounts] = await Promise.all([
    deps.searches.list(actor.organizationId),
    deps.searches.listBatches(actor.organizationId),
    deps.searches.countConnectedAccounts(actor.organizationId),
  ]);
  return { searches, batches, connectedAccounts, defaultMaxResults: DEFAULT_MAX_RESULTS, maxResultsLimit: MAX_SEARCH_RESULTS };
}

export async function getLinkedInSearch(deps: LinkedInSearchDeps, actor: Actor, id: string) {
  const search = await deps.searches.get(actor.organizationId, id);
  if (!search) throw new NotFoundError("Search not found");
  return search;
}

const VERB: Record<SearchAction, string> = { pause: "paused", resume: "resumed", cancel: "cancelled" };

/** Pause, resume or cancel. Resume also retries a failed search from its last page. People already found stay in Leads. */
export async function changeLinkedInSearch(deps: LinkedInSearchDeps, actor: Actor, id: string, action: SearchAction): Promise<{ status: string }> {
  const search = await getLinkedInSearch(deps, actor, id);
  if (!canApply(search.status, action)) throw new ConflictError(`A ${search.status.replace("_", " ")} search cannot be ${VERB[action]}.`);
  if (!(await deps.searches.apply(actor.organizationId, id, action))) throw new ConflictError("The search changed while you were looking. Reload and try again.");
  return { status: (await getLinkedInSearch(deps, actor, id)).status };
}
