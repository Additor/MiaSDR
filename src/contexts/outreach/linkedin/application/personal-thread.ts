import { isOwnerOrAdmin } from "@/contexts/tenancy/domain/roles";
import { ForbiddenError, NotFoundError, type Actor } from "@/shared/errors";
import { canReadPersonalThread, type CampaignType } from "../../domain/campaign";

export interface PersonalThreadMessage {
  id: string;
  direction: "inbound" | "outbound";
  at: Date;
  text: string;
}

export interface PersonalThread {
  campaignId: string;
  campaignName: string;
  personName: string | null;
  messages: PersonalThreadMessage[];
}

export interface PersonalThreadStore {
  campaign(organizationId: string, id: string): Promise<{ id: string; name: string; type: CampaignType; createdBy: string | null } | null>;
  /** Messages of the private conversation of this enrollment's person on the enrollment's account. Empty when nobody replied. */
  thread(organizationId: string, campaignId: string, enrollmentId: string): Promise<{ personName: string | null; messages: PersonalThreadMessage[] } | null>;
}

/**
 * Reads the replies of one lead of a personal campaign. The Inbox never shows them; this is the only way in.
 * Owners, admins and the campaign's creator may read. A regular campaign has no private threads, so it answers not found.
 */
export async function readPersonalThread(deps: { store: PersonalThreadStore }, actor: Actor, campaignId: string, enrollmentId: string): Promise<PersonalThread> {
  const campaign = await deps.store.campaign(actor.organizationId, campaignId);
  if (!campaign || campaign.type !== "personal") throw new NotFoundError("Personal campaign not found");
  if (!canReadPersonalThread({ isOwnerOrAdmin: isOwnerOrAdmin(actor.role), actorUserId: actor.userId, createdBy: campaign.createdBy })) {
    throw new ForbiddenError("Only an owner, an admin or the person who created this campaign can read its replies.");
  }
  const thread = await deps.store.thread(actor.organizationId, campaignId, enrollmentId);
  if (!thread) throw new NotFoundError("Lead not found");
  return { campaignId: campaign.id, campaignName: campaign.name, personName: thread.personName, messages: thread.messages };
}
