import type { DbHandle } from "@/platform/db/client";
import type { Actor } from "@/shared/errors";
import { noticesForPeople, type CrossCampaignNoticeReader } from "../../application/cross-campaign-notices";
import { enrollLinkedInLeads, enrollPickedLinkedInLeads, type LinkedInCampaignDeps } from "./linkedin-campaigns";

export interface NoticeDeps extends LinkedInCampaignDeps {
  notices: CrossCampaignNoticeReader;
}

/**
 * Enrolls leads by query like `enrollLinkedInLeads` and adds `notices`: the people this call enrolled who were already contacted in
 * another campaign, and the leads of this campaign the account rule skipped. The enrollment itself is unchanged.
 */
export async function enrollLinkedInLeadsWithNotices(deps: NoticeDeps, actor: Actor, id: string, input: { query?: string; limit?: number; dryRun?: boolean }, tx?: DbHandle) {
  const { addedPersonIds, ...result } = await enrollLinkedInLeads(deps, actor, id, { ...input, collectIds: true }, tx);
  // A dry run enrolls nobody, so it has no notices to report.
  if (input.dryRun) return { ...result, notices: await noticesForPeople(deps.notices, actor.organizationId, id, []) };
  return { ...result, notices: await noticesForPeople(deps.notices, actor.organizationId, id, addedPersonIds ?? []) };
}

/** The same for hand-picked people. The notices cover every person picked, enrolled now or not. */
export async function enrollPickedLinkedInLeadsWithNotices(deps: NoticeDeps, actor: Actor, id: string, personIds: string[], tx?: DbHandle) {
  const result = await enrollPickedLinkedInLeads(deps, actor, id, personIds, tx);
  return { ...result, notices: await noticesForPeople(deps.notices, actor.organizationId, id, [...new Set(personIds)]) };
}
