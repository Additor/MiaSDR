import { dealsDeps } from "@/composition/deals";
import { contactDeleteDeps, leadDeleteDeps } from "@/composition/person-lifecycle";
import { deleteDeal } from "@/contexts/deals/application/deal-edit";
import { getDeal } from "@/contexts/deals/application/deal-reads";
import { canDeleteDeal } from "@/contexts/deals/domain/deal";
import { agentCompleteCampaign, agentDeleteDraftCampaign, previewAgentCampaignEnd, type AgentChannel } from "@/contexts/outreach/application/agent-campaigns";
import { agentCampaignDeps } from "@/contexts/outreach/infrastructure/agent-campaign-composition";
import { deleteContact, flatten, previewContactDelete, type ContactDeleteBlocker, type ContactDeleteCounts, type ContactDeleteExpected } from "@/contexts/people/application/contact-delete";
import { BLOCK_MESSAGES } from "@/contexts/people/application/lead-delete-terms";
import { deleteLeads, previewLeadDelete } from "@/contexts/people/application/lead-management";
import { AGENT_DELETE_PROTECTED } from "@/contexts/people/domain/person-delete-policy";
import { withAgentUsage } from "@/contexts/tenancy/application/mcp-agent-usage";
import { agentUsageDeps } from "@/contexts/tenancy/infrastructure/mcp-composition";
import { actionToken, actionTokenMatches, actionTokenStale, readActionToken } from "@/shared/action-token";
import { ConflictError, NotFoundError, type Actor } from "@/shared/errors";

/*
 * What an agent does that no one can undo: complete a campaign, delete a lead, contact, deal or draft campaign. Each runs
 * the use case a person's button calls, on one target per call. A preview says what the action would erase and hands out
 * a token of what it read; the action reserves against the organization's daily limit, then checks the token and every
 * rule again. A refusal gives the reservation back (`withAgentUsage`).
 */

export const IRREVERSIBLE_KINDS = ["complete_campaign", "delete_lead", "delete_contact", "delete_deal", "delete_draft_campaign"] as const;
export type IrreversibleKind = (typeof IRREVERSIBLE_KINDS)[number];

export type IrreversibleTarget =
  | { kind: "complete_campaign" | "delete_draft_campaign"; channel: AgentChannel; campaignId: string }
  | { kind: "delete_lead" | "delete_contact"; personId: string }
  | { kind: "delete_deal"; dealId: string };

export interface IrreversibleRefusal {
  code: string;
  message: string;
}

export interface IrreversiblePreview {
  kind: IrreversibleKind;
  targetId: string;
  name: string | null;
  /** What the action would do, as a sentence for the person. */
  effect: string;
  /** What stops it now. A token comes only when this is empty. */
  refusals: IrreversibleRefusal[];
  actionToken: string | null;
  /** What a contact delete erases. */
  erases: ContactDeleteCounts | null;
  /** The campaign is completed already, so there is nothing to do. */
  alreadyDone: boolean;
}

const CONTACT_BLOCKERS: Record<ContactDeleteBlocker["reason"], string> = {
  open_deals: "This contact has an open deal. Close or delete it first.",
  send_in_flight: "A message to this contact is going out. Try again in a moment.",
  recent_send: "A message went to this contact a moment ago. Try again once the send has settled.",
  recent_invite: "A LinkedIn invitation went to this contact a moment ago. Try again once it has settled.",
  ai_job_running: "An AI job is working on this contact's replies. Try again in a moment.",
  private_conversation: "This contact has another member's private conversation. Ask that member, an owner or an admin.",
  personal_campaign_sends: "This contact is in another member's personal campaign. Ask its creator, an owner or an admin.",
};

const targetIdOf = (target: IrreversibleTarget): string => ("dealId" in target ? target.dealId : "personId" in target ? target.personId : target.campaignId);

const countWords = (counts: ContactDeleteCounts) =>
  `${counts.conversations} conversations with ${counts.messages} messages, ${counts.deals.won + counts.deals.lost} closed deals, ${counts.notes} notes, ${counts.tasks} tasks and ${counts.sends} sends`;

async function previewPerson(actor: Actor, kind: "delete_lead" | "delete_contact", personId: string): Promise<IrreversiblePreview> {
  const base = { kind, targetId: personId, erases: null, alreadyDone: false };
  if (kind === "delete_lead") {
    const lead = await previewLeadDelete(leadDeleteDeps, actor, personId);
    if (!lead) throw new NotFoundError("Lead not found");
    const refusals = lead.blocked ? [{ code: lead.blocked, message: BLOCK_MESSAGES[lead.blocked] }] : [];
    return {
      ...base,
      name: lead.name,
      effect: "Deletes this lead, its custom fields and its campaign enrollments.",
      refusals,
      actionToken: refusals.length > 0 ? null : actionToken(kind, personId, { name: lead.name }),
    };
  }
  const contact = await previewContactDelete(contactDeleteDeps, actor, personId);
  const refusals: IrreversibleRefusal[] = [
    ...(contact.agentProtected ? [{ code: "agent_delete_protected", message: AGENT_DELETE_PROTECTED }] : []),
    ...contact.blockers.map((blocker) => ({ code: blocker.reason, message: CONTACT_BLOCKERS[blocker.reason] })),
  ];
  return {
    ...base,
    name: contact.person.fullName ?? contact.person.email,
    effect: `Deletes this contact and, for good, ${countWords(contact.counts)}.`,
    erases: contact.counts,
    refusals,
    actionToken: refusals.length > 0 ? null : actionToken(kind, personId, flatten(contact.counts)),
  };
}

/** What the action would do and whether it can run. It changes nothing and counts against no limit. */
export async function previewIrreversible(actor: Actor, target: IrreversibleTarget): Promise<IrreversiblePreview> {
  const targetId = targetIdOf(target);
  if ("personId" in target) return previewPerson(actor, target.kind, target.personId);
  if ("dealId" in target) {
    const deal = await getDeal(dealsDeps(), actor, target.dealId);
    const refusals = canDeleteDeal({ stageKind: deal.stage.kind }) ? [] : [{ code: "deal_closed", message: "Only an open deal can be deleted. A won or lost deal stays as history." }];
    return {
      kind: target.kind,
      targetId,
      name: deal.title,
      effect: "Deletes this open deal. The contact stays.",
      refusals,
      erases: null,
      alreadyDone: false,
      actionToken: refusals.length > 0 ? null : actionToken(target.kind, targetId, { version: deal.version }),
    };
  }
  const campaign = await previewAgentCampaignEnd(agentCampaignDeps(), actor, target);
  return {
    kind: target.kind,
    targetId,
    name: campaign.name,
    effect: target.kind === "complete_campaign" ? "Ends this campaign for good. No more steps go out and nobody can restart it." : "Deletes this draft campaign and its enrollments.",
    refusals: campaign.refusals,
    erases: null,
    alreadyDone: campaign.alreadyCompleted,
    actionToken: campaign.actionToken,
  };
}

async function deleteOnePerson(actor: Actor, personId: string, token: string): Promise<void> {
  const preview = await previewPerson(actor, "delete_lead", personId);
  if (!actionTokenMatches(token, "delete_lead", personId, { name: preview.name })) throw actionTokenStale();
  const { deleted, blocked } = await deleteLeads(leadDeleteDeps, actor, { ids: [personId] });
  if (blocked[0]) throw new ConflictError(BLOCK_MESSAGES[blocked[0].reason], { code: blocked[0].reason });
  if (deleted === 0) throw new NotFoundError("Lead not found");
}

async function deleteOneContact(actor: Actor, personId: string, token: string): Promise<void> {
  const expected = readActionToken<ContactDeleteExpected>(token, "delete_contact", personId);
  if (!expected) throw actionTokenStale();
  await deleteContact(contactDeleteDeps, actor, personId, { expected }).catch((error: unknown) => {
    throw error instanceof ConflictError && error.details?.code === "counts_changed" ? actionTokenStale() : error;
  });
}

async function deleteOneDeal(actor: Actor, dealId: string, token: string): Promise<void> {
  const state = readActionToken<{ version: number }>(token, "delete_deal", dealId);
  if (!state) throw actionTokenStale();
  await deleteDeal(dealsDeps(), actor, dealId, { expectedVersion: state.version }).catch((error: unknown) => {
    throw error instanceof ConflictError && error.details?.code === "stale_version" ? actionTokenStale() : error;
  });
}

/**
 * Runs the action once under the daily limit. A second call to complete a completed campaign answers `alreadyDone`
 * and reserves nothing, so a client that lost the answer can repeat it.
 */
export async function applyIrreversible(actor: Actor, target: IrreversibleTarget, token: string): Promise<{ alreadyDone: boolean }> {
  if (target.kind === "complete_campaign" && (await previewAgentCampaignEnd(agentCampaignDeps(), actor, target)).alreadyCompleted) return { alreadyDone: true };
  await withAgentUsage(agentUsageDeps(), actor, { kind: "irreversible", amount: 1 }, async () => {
    switch (target.kind) {
      case "complete_campaign":
        return agentCompleteCampaign(agentCampaignDeps(), actor, { channel: target.channel, campaignId: target.campaignId, token });
      case "delete_draft_campaign":
        return agentDeleteDraftCampaign(agentCampaignDeps(), actor, { channel: target.channel, campaignId: target.campaignId, token });
      case "delete_lead":
        return deleteOnePerson(actor, target.personId, token);
      case "delete_contact":
        return deleteOneContact(actor, target.personId, token);
      case "delete_deal":
        return deleteOneDeal(actor, target.dealId, token);
    }
  });
  return { alreadyDone: false };
}
