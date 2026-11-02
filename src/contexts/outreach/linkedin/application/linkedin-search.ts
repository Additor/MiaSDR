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

export const createLinkedInSearch = (deps: LinkedInSearchDeps, actor: Actor, input: CreateSearchInput): Promise<{ id: string }> => prepareAndCreate(deps, actor, input);

async function prepareAndCreate(deps: LinkedInSearchDeps, actor: Actor, input: CreateSearchInput & { agent?: { accountIds: string[]; tokenId: string } }): Promise<{ id: string }> {
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
  return { id: await deps.searches.create(actor.organizationId, { name, url: url.value.url, maxResults, campaignId, agent: input.agent }) };
}

/** Results one agent search may ask for. A person's limit is higher; the daily limit counts each agent search whole. */
export const MAX_AGENT_SEARCH_RESULTS = 500;
export const DEFAULT_AGENT_SEARCH_RESULTS = 100;

/**
 * An agent's search: leads only, never a campaign, because a search that enrolls would pass the enroll limit and the
 * launch token. It runs on the token's person's accounts and on accounts no member owns, never on another member's
 * personal LinkedIn.
 */
export async function createAgentLinkedInSearch(deps: LinkedInSearchDeps, actor: Actor, input: { name: string; url: string; maxResults: number }): Promise<{ id: string }> {
  if (!actor.via) throw new Error("An agent search needs an agent actor.");
  const accountIds = await deps.searches.agentSearchAccounts(actor.organizationId, actor.userId);
  if (accountIds.length === 0) {
    throw new ConflictError("No LinkedIn account this token's person owns, or that no member owns, is connected. Connect one, or an admin sets the owner under Settings, LinkedIn.", { code: "agent_no_search_account" });
  }
  return prepareAndCreate(deps, actor, { ...input, campaignId: null, agent: { accountIds, tokenId: actor.via.tokenId } });
}

/** An agent cancels only what an agent created. A person's search stays a person's to end. */
export async function cancelAgentLinkedInSearch(deps: LinkedInSearchDeps, actor: Actor, id: string): Promise<{ status: string }> {
  const search = await getLinkedInSearch(deps, actor, id);
  if (!search.byAgent) throw new ConflictError("A person created this search, so only a person cancels it in MiaSDR.", { code: "agent_search_not_agents" });
  return changeLinkedInSearch(deps, actor, id, "cancel");
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
