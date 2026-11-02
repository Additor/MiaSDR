import { z } from "zod";
import type { EnrollOptions } from "@/contexts/outreach/application/enroll-options";
import { createCampaign, enrollLeads, enrollPickedLeads, updateCampaign } from "@/contexts/outreach/application/campaign-management";
import type { StepInput } from "@/contexts/outreach/domain/campaign";
import { campaignDeps } from "@/contexts/outreach/infrastructure/composition";
import { createLinkedInCampaign, enrollLinkedInLeads, enrollPickedLinkedInLeads, updateLinkedInCampaign } from "@/contexts/outreach/linkedin/application/linkedin-campaigns";
import type { LinkedInStep } from "@/contexts/outreach/linkedin/domain/linkedin";
import { linkedinCampaignDeps } from "@/contexts/outreach/linkedin/infrastructure/linkedin-composition";
import { agentEnroll, agentUpdateCampaign } from "@/contexts/outreach/application/agent-campaigns";
import { agentCampaignDeps } from "@/contexts/outreach/infrastructure/agent-campaign-composition";
import type { DbHandle } from "@/platform/db/client";
import { ValidationError, type Actor } from "@/shared/errors";
import { CHANNELS, STEP_BODY_CHARS } from "./campaigns";
import { CHANGES, defineTool } from "./define";
import { appLinks, cutCopyRefusal, isCutCopy } from "./output";

type Channel = (typeof CHANNELS)[number];
const ACTIONS = ["create", "update", "add_leads"] as const;

/**
 * The statuses an agent enrolls into. A running campaign also needs the campaign policy and an `enroll` launch token,
 * which `agentEnroll` checks under the campaign lock before this runs.
 */
const AGENT_ENROLL: EnrollOptions = { allowedStatuses: ["draft", "paused", "active"] };

/** People one add_leads call may name. */
const MAX_AGENT_PICKED = 500;

/** Enroll counts of either channel and either way of picking, keyed the same way. */
type Counts = Record<string, number | undefined>;
const counted = async (result: Promise<object>): Promise<Counts> => (await result) as Counts;

interface ChannelWrites {
  create(actor: Actor, input: { name: string; personal: boolean; senderIds?: string[] }): Promise<{ id: string }>;
  update(actor: Actor, id: string, patch: { name?: string; steps?: unknown[]; senderIds?: string[] }, tx: DbHandle): Promise<void>;
  byQuery(actor: Actor, id: string, query: string, dryRun: boolean, tx: DbHandle): Promise<Counts>;
  picked(actor: Actor, id: string, personIds: string[], dryRun: boolean, tx: DbHandle): Promise<Counts>;
}

const WRITES: Record<Channel, ChannelWrites> = {
  email: {
    create: (actor, input) => createCampaign(campaignDeps(), actor, { name: input.name, senderIds: input.senderIds }),
    update: (actor, id, patch, tx) => updateCampaign(campaignDeps(), actor, id, { ...patch, steps: patch.steps as StepInput[] | undefined }, tx),
    byQuery: (actor, id, query, dryRun, tx) => counted(enrollLeads(campaignDeps(), actor, id, { query, dryRun }, AGENT_ENROLL, tx)),
    picked: (actor, id, personIds, dryRun, tx) => counted(enrollPickedLeads(campaignDeps(), actor, id, personIds, { ...AGENT_ENROLL, dryRun }, tx)),
  },
  linkedin: {
    create: (actor, input) => createLinkedInCampaign(linkedinCampaignDeps(), actor, { name: input.name, type: input.personal ? "personal" : undefined, senderIds: input.senderIds }),
    update: (actor, id, patch, tx) => updateLinkedInCampaign(linkedinCampaignDeps(), actor, id, { ...patch, steps: patch.steps as LinkedInStep[] | undefined }, tx),
    byQuery: (actor, id, query, dryRun, tx) => counted(enrollLinkedInLeads(linkedinCampaignDeps(), actor, id, { query, dryRun }, AGENT_ENROLL, tx)),
    picked: (actor, id, personIds, dryRun, tx) => counted(enrollPickedLinkedInLeads(linkedinCampaignDeps(), actor, id, personIds, { ...AGENT_ENROLL, dryRun }, tx)),
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
    "Prepares a campaign; nothing here sends. `create` makes a draft (`channel`, `name`, optional `senderIds`; LinkedIn `personal`).",
    "`update` changes `name`, `steps` or `senderIds` of a draft or paused campaign; `steps` replace all steps (email: kind email, subject, body, waitDays; LinkedIn: invitation then messages), so read a step get_campaign marks `truncated` whole with `previewStep` before you send it back; a cut body is refused (`truncated_text`).",
    "`add_leads` enrolls leads by Leads search `query` or `personIds` (up to 500); call it with `dryRun: true` first to see the counts. Agents enroll a limited number of leads a day (`agent_enroll_cap`).",
    "Adding to a running campaign needs a token that sends, agent campaigns allowed, and `launchToken` from preview_campaign_launch with `purpose: enroll`.",
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
    launchToken: z.string().optional(),
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
      return answer(id, `Created draft campaign ${id}. Set its steps with update; a person starts it in MiaSDR, or launch_campaign where agents may start campaigns.`);
    }
    const campaignId = input.campaignId;
    if (!campaignId) throw new ValidationError(`${input.action} needs campaignId.`);
    if (input.action === "update") {
      if (input.name === undefined && input.steps === undefined && input.senderIds === undefined) throw new ValidationError("update needs name, steps or senderIds.");
      await agentUpdateCampaign(
        agentCampaignDeps(),
        actor,
        { channel: input.channel, campaignId, changesSenders: input.senderIds !== undefined },
        (saved) => {
          // `steps` replace every step, so a body get_campaign cut must not come back as the whole step.
          const old = saved.steps as Array<{ body: string }>;
          if (input.steps?.some((s) => old.some((o) => isCutCopy(s.body, o.body, STEP_BODY_CHARS)))) throw cutCopyRefusal("step body");
        },
        (tx) => writes.update(actor, campaignId, { name: input.name, steps: input.steps, senderIds: input.senderIds }, tx),
      );
      return answer(campaignId, "Saved the campaign.");
    }
    if ((input.query === undefined) === (input.personIds === undefined)) throw new ValidationError("add_leads needs query or personIds, not both.");
    const dryRun = input.dryRun === true;
    const counts = await agentEnroll(agentCampaignDeps(), actor, { channel: input.channel, campaignId, launchToken: input.launchToken, dryRun }, (tx) =>
      input.personIds ? writes.picked(actor, campaignId, input.personIds, dryRun, tx) : writes.byQuery(actor, campaignId, input.query ?? "", dryRun, tx),
    );
    const skipped = Object.fromEntries(SKIP_KEYS.flatMap((key) => (counts[key] ? [[key.replace(/^skipped/, "").replace(/^./, (c) => c.toLowerCase()), counts[key] as number]] : [])));
    const added = counts.added ?? 0;
    const wouldAdd = dryRun ? (counts.wouldAdd ?? added) : null;
    const enroll = { dryRun, requested: counts.requested ?? 0, added: dryRun ? 0 : added, wouldAdd, skipped };
    const summary = dryRun ? `Would add ${wouldAdd} lead(s). Call again without dryRun to add them.` : `Added ${added} lead(s).`;
    return answer(campaignId, summary, enroll);
  },
});
