import type { DbHandle } from "@/platform/db/client";
import { LIMIT_PAUSE_HOURS, pickMinutes, profileUrlFor } from "../domain/linkedin";
import { resultMemberId } from "../domain/linkedin-identity";
import { MAX_SEARCH_FAILURES, MAX_SEARCH_PAGES, itemsToKeep, resultSlug, searchRetrySeconds } from "../domain/linkedin-search";
import { LinkedInGatewayError, type SearchItem } from "./linkedin-ports";
import type { FoundResult, LinkedInSearchEngineDeps, SearchPageClaim } from "./linkedin-search-ports";

export type SearchOutcome =
  | { kind: "idle" }
  | { kind: "page"; kept: number; done: boolean; skippedContact: number }
  /** Cancelled, or the claim expired, while the provider call ran. Nothing was stored and no lead was created. */
  | { kind: "dropped" }
  | { kind: "retry" }
  | { kind: "failed" }
  | { kind: "paused"; reason: "limit" | "disconnected" | "no_gateway" };

const NO_GATEWAY_RETRY_MINUTES = 5;
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Claims and reads at most one search page. One account serves the claim.
 * A search is a read, so an unknown outcome (timeout, 5xx) retries the same cursor after a backoff.
 * The cursor moves only after the page is stored, and storing is idempotent, so a crash re-reads the page and adds nothing twice.
 */
export async function runNextSearchPage(deps: LinkedInSearchEngineDeps): Promise<SearchOutcome> {
  const now = deps.clock.now();
  const claim = await deps.store.claimPage({ now, random: deps.random });
  if (!claim) return { kind: "idle" };

  const gateway = await deps.gateways.forOrganization(claim.organizationId);
  if (!gateway) {
    await deps.store.release(claim, { error: "LinkedIn is not connected for this organization.", retryAt: new Date(now.getTime() + NO_GATEWAY_RETRY_MINUTES * 60_000), unknownFailure: false });
    return { kind: "paused", reason: "no_gateway" };
  }

  let page;
  try {
    page = await gateway.searchPeople({ account: claim.account.providerAccountId, searchUrl: claim.url, cursor: claim.cursor });
  } catch (error) {
    return handleError(deps, claim, error);
  }

  const kept = page.items.slice(0, itemsToKeep({ pageSize: page.items.length, maxResults: claim.maxResults, alreadyFound: claim.found }));
  const done = page.nextCursor === null || page.items.length === 0 || claim.found + kept.length >= claim.maxResults || claim.pagesFetched + 1 >= MAX_SEARCH_PAGES;
  const gap = pickMinutes(claim.gapSeconds, deps.random);
  // `results` runs once inside the page transaction, and not at all when the claim is no longer current.
  let skippedContact = 0;
  const recorded = await deps.store.recordPage(
    claim,
    {
      results: async (tx) => {
        const found = await toResults(deps, claim, kept, tx);
        skippedContact = found.skippedContact;
        return found.results;
      },
      received: page.items.length,
      nextCursor: done ? null : page.nextCursor,
      totalEstimate: page.totalEstimate,
      done,
    },
    deps.clock.now(),
    gap,
  );
  return recorded ? { kind: "page", kept: kept.length, done, skippedContact } : { kind: "dropped" };
}

async function toResults(deps: LinkedInSearchEngineDeps, claim: SearchPageClaim, items: SearchItem[], tx: DbHandle): Promise<{ results: FoundResult[]; skippedContact: number }> {
  if (items.length === 0) return { results: [], skippedContact: 0 };
  // The stored key is the profile URL of the public slug. A result with only a member id becomes a lead known by that id,
  // and keeps the URL the provider gave. A result with neither creates nothing.
  const keyed = items.map((item) => {
    const slug = resultSlug(item);
    const memberId = slug ? null : resultMemberId(item);
    return { item, slug, memberId, profileUrl: slug ? profileUrlFor(slug) : (item.profileUrl ?? item.identifier) };
  });
  const { ids: people, skippedContact } = await deps.sink.importPeople({
    organizationId: claim.organizationId,
    searchId: claim.searchId,
    campaignId: claim.targetCampaignId,
    tx,
    people: keyed
      .filter((k) => k.slug || k.memberId)
      .map(({ item, slug, memberId, profileUrl }) => ({
        key: profileUrl,
        // A member id is never read as a slug, so the profile text stays empty for those results.
        profile: slug ? profileUrl : "",
        name: item.name,
        headline: item.headline,
        ...(memberId ? { memberId, url: item.profileUrl } : {}),
      })),
  });
  return { results: keyed.map(({ item, profileUrl }) => ({ profileUrl, item, personId: people.get(profileUrl) ?? null })), skippedContact };
}

async function handleError(deps: LinkedInSearchEngineDeps, claim: SearchPageClaim, error: unknown): Promise<SearchOutcome> {
  const now = deps.clock.now();
  const message = errorText(error);
  if (error instanceof LinkedInGatewayError && error.kind === "definite") {
    if (error.code === "rate_limited") {
      await deps.store.pauseAccountForLimit(claim, new Date(now.getTime() + LIMIT_PAUSE_HOURS * 3_600_000));
      return { kind: "paused", reason: "limit" };
    }
    if (error.code === "auth") {
      await deps.store.disconnectAccount(claim, message);
      return { kind: "paused", reason: "disconnected" };
    }
    // The provider answered with a refusal (bad URL, search not allowed). Trying again changes nothing.
    await deps.store.fail(claim, message, now);
    return { kind: "failed" };
  }
  const failures = claim.failures + 1;
  if (failures >= MAX_SEARCH_FAILURES) {
    await deps.store.fail(claim, `${message} (gave up after ${failures} tries)`, now);
    return { kind: "failed" };
  }
  await deps.store.release(claim, { error: message, retryAt: new Date(now.getTime() + searchRetrySeconds(failures) * 1000), unknownFailure: true });
  return { kind: "retry" };
}
