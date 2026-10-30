import { z } from "zod";
import type { EnrollOptions } from "@/contexts/outreach/application/enroll-options";
import { createCampaign, enrollLeads, enrollPickedLeads, updateCampaign } from "@/contexts/outreach/application/campaign-management";
import type { StepInput } from "@/contexts/outreach/domain/campaign";
import { parseEnrollmentListQuery } from "@/contexts/outreach/domain/enrollment-list";
import { campaignDeps } from "@/contexts/outreach/infrastructure/composition";
import { createLinkedInCampaign, enrollLinkedInLeads, enrollPickedLinkedInLeads, updateLinkedInCampaign } from "@/contexts/outreach/linkedin/application/linkedin-campaigns";
import type { LinkedInStep } from "@/contexts/outreach/linkedin/domain/linkedin";
import { linkedinCampaignDeps } from "@/contexts/outreach/linkedin/infrastructure/linkedin-composition";
import { ConflictError, ValidationError, type Actor } from "@/shared/errors";
import { CHANNELS, READS } from "./campaigns";
import { CHANGES, defineTool } from "./define";
import { appLinks } from "./output";

type Channel = (typeof CHANNELS)[number];
const ACTIONS = ["create", "update", "add_leads"] as const;

/** An agent adds leads only to a campaign that is not sending. Adding to a running one arrives with agent sending. */
const AGENT_ENROLL: EnrollOptions = { allowedStatuses: ["draft", "paused"] };

/** People one add_leads call may name. */
const MAX_AGENT_PICKED = 500;

/** Enroll counts of either channel and either way of picking, keyed the same way. */
type Counts = Record<string, number | undefined>;
const counted = async (result: Promise<object>): Promise<Counts> => (await result) as Counts;

interface ChannelWrites {
  create(actor: Actor, input: { name: string; personal: boolean; senderIds?: string[] }): Promise<{ id: string }>;
  update(actor: Actor, id: string, patch: { name?: string; steps?: unknown[]; senderIds?: string[] }): Promise<void>;
  byQuery(actor: Actor, id: string, query: string, dryRun: boolean): Promise<Counts>;
  picked(actor: Actor, id: string, personIds: string[], dryRun: boolean): Promise<Counts>;
}

const WRITES: Record<Channel, ChannelWrites> = {
  email: {
    create: (actor, input) => createCampaign(campaignDeps(), actor, { name: input.name, senderIds: input.senderIds }),
    update: (actor, id, patch) => updateCampaign(campaignDeps(), actor, id, { ...patch, steps: patch.steps as StepInput[] | undefined }),
    byQuery: (actor, id, query, dryRun) => counted(enrollLeads(campaignDeps(), actor, id, { query, dryRun }, AGENT_ENROLL)),
    picked: (actor, id, personIds, dryRun) => counted(enrollPickedLeads(campaignDeps(), actor, id, personIds, { ...AGENT_ENROLL, dryRun })),
  },
  linkedin: {
    create: (actor, input) => createLinkedInCampaign(linkedinCampaignDeps(), actor, { name: input.name, type: input.personal ? "personal" : undefined, senderIds: input.senderIds }),
    update: (actor, id, patch) => updateLinkedInCampaign(linkedinCampaignDeps(), actor, id, { ...patch, steps: patch.steps as LinkedInStep[] | undefined }),
    byQuery: (actor, id, query, dryRun) => counted(enrollLinkedInLeads(linkedinCampaignDeps(), actor, id, { query, dryRun }, AGENT_ENROLL)),
    picked: (actor, id, personIds, dryRun) => counted(enrollPickedLinkedInLeads(linkedinCampaignDeps(), actor, id, personIds, { ...AGENT_ENROLL, dryRun })),
  },
};

const SKIP_KEYS = ["skippedMissingIdentity", "skippedDuplicate", "skippedRemoved", "skippedSuppressed", "skippedDoNotContact", "skippedContact", "skippedNotFound"] as const;

const enrollView = z.object({ dryRun: z.boolean(), requested: z.number(), added: z.number(), wouldAdd: z.number().nullable(), skipped: z.record(z.string(), z.number()) });

const step = z.object({
  stepNumber: z.number().int(),
  kind: z.enum(["email", "invitation", "message"]),
  subject: z.string().optional(),
  body: z.string(),
  waitDays: z.number().int(),
});

export const draftCampaignTool = defineTool({
  name: "draft_campaign",
  title: "Draft campaign",
  description: [
    "Prepares a campaign that a person starts in MiaSDR; nothing here sends. `create` makes a draft (`channel`, `name`, optional `senderIds`; LinkedIn `personal`).",
    "`update` changes `name`, `steps` or `senderIds` of a draft or paused campaign; `steps` replace all steps (email: kind email, subject, body, waitDays; LinkedIn: invitation then messages).",
    "`add_leads` enrolls leads by Leads search `query` or `personIds` (up to 500) into a draft or paused campaign; call it with `dryRun: true` first to see the counts.",
  ].join(" "),
  scope: "mcp:write",
  annotations: CHANGES,
  input: z.object({
    action: z.enum(ACTIONS),
    channel: z.enum(CHANNELS),
    campaignId: z.string().optional(),
    name: z.string().optional(),
    personal: z.boolean().optional(),
    steps: z.array(step).optional(),
    senderIds: z.array(z.string()).optional(),
    query: z.string().optional(),
    personIds: z.array(z.string()).max(MAX_AGENT_PICKED).optional(),
    dryRun: z.boolean().optional(),
  }),
  output: z.object({
    action: z.enum(ACTIONS),
    channel: z.enum(CHANNELS),
    campaignId: z.string(),
    enroll: enrollView.nullable(),
    appUrl: z.string(),
  }),
  async run({ actor, out }, input) {
    const writes = WRITES[input.channel];
    const answer = (campaignId: string, summary: string, enroll: z.infer<typeof enrollView> | null = null) => ({
      summary,
      structured: { action: input.action, channel: input.channel, campaignId, enroll, appUrl: appLinks(out).campaign(campaignId) },
    });
    if (input.action === "create") {
      if (!input.name) throw new ValidationError("create needs name.");
      const { id } = await writes.create(actor, { name: input.name, personal: input.personal === true, senderIds: input.senderIds });
      return answer(id, `Created draft campaign ${id}. Set its steps with update, then a person starts it in MiaSDR.`);
    }
    const campaignId = input.campaignId;
    if (!campaignId) throw new ValidationError(`${input.action} needs campaignId.`);
    if (input.action === "update") {
      if (input.name === undefined && input.steps === undefined && input.senderIds === undefined) throw new ValidationError("update needs name, steps or senderIds.");
      if (input.senderIds !== undefined) {
        const { campaign } = await READS[input.channel].detail(actor, campaignId, parseEnrollmentListQuery({ size: "1" }));
        if (campaign.status === "active") throw new ConflictError("Pause the campaign before an agent changes its senders.", { code: "agent_sender_change_active" });
      }
      await writes.update(actor, campaignId, { name: input.name, steps: input.steps, senderIds: input.senderIds });
      return answer(campaignId, "Saved the campaign.");
    }
    if ((input.query === undefined) === (input.personIds === undefined)) throw new ValidationError("add_leads needs query or personIds, not both.");
    const dryRun = input.dryRun === true;
    const counts = input.personIds ? await writes.picked(actor, campaignId, input.personIds, dryRun) : await writes.byQuery(actor, campaignId, input.query ?? "", dryRun);
    const skipped = Object.fromEntries(SKIP_KEYS.flatMap((key) => (counts[key] ? [[key.replace(/^skipped/, "").replace(/^./, (c) => c.toLowerCase()), counts[key] as number]] : [])));
    const added = counts.added ?? 0;
    const wouldAdd = dryRun ? (counts.wouldAdd ?? added) : null;
    const enroll = { dryRun, requested: counts.requested ?? 0, added: dryRun ? 0 : added, wouldAdd, skipped };
    const summary = dryRun ? `Would add ${wouldAdd} lead(s). Call again without dryRun to add them.` : `Added ${added} lead(s).`;
    return answer(campaignId, summary, enroll);
  },
});
