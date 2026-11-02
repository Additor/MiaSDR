import { z } from "zod";
import { stepSchema } from "@/app/api/campaigns/step-schema";
import { linkedinStepSchema } from "@/app/api/linkedin/campaigns/step-schema";
import { noticesForPeople } from "@/contexts/outreach/application/cross-campaign-notices";
import type { EnrollOptions } from "@/contexts/outreach/application/enroll-options";
import { createCampaign, enrollLeads, enrollPickedLeads, updateCampaign } from "@/contexts/outreach/application/campaign-management";
import type { StepInput } from "@/contexts/outreach/domain/campaign";
import { campaignDeps } from "@/contexts/outreach/infrastructure/composition";
import { createLinkedInCampaign, enrollLinkedInLeads, enrollPickedLinkedInLeads, updateLinkedInCampaign } from "@/contexts/outreach/linkedin/application/linkedin-campaigns";
import type { LinkedInStep } from "@/contexts/outreach/linkedin/domain/linkedin";
import { linkedinCampaignDeps, linkedinNoticeDeps } from "@/contexts/outreach/linkedin/infrastructure/linkedin-composition";
import { agentEnroll, agentUpdateCampaign } from "@/contexts/outreach/application/agent-campaigns";
import { agentCampaignDeps } from "@/contexts/outreach/infrastructure/agent-campaign-composition";
import type { DbHandle } from "@/platform/db/client";
import { ValidationError, type Actor } from "@/shared/errors";
import { CHANNELS, STEP_BODY_CHARS } from "./campaigns";
import { CHANGES, defineTool } from "./define";
import { appLinks, bodyReadToken, cutCopyRefusal, isCutCopy, unfenced } from "./output";

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
type Counts = Partial<Record<(typeof SKIP_KEYS)[number] | "added" | "wouldAdd" | "requested", number>> & { addedPersonIds?: string[] };
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
    byQuery: (actor, id, query, dryRun, tx) => counted(enrollLinkedInLeads(linkedinCampaignDeps(), actor, id, { query, dryRun, collectIds: true }, AGENT_ENROLL, tx)),
    picked: (actor, id, personIds, dryRun, tx) => counted(enrollPickedLinkedInLeads(linkedinCampaignDeps(), actor, id, personIds, { ...AGENT_ENROLL, dryRun }, tx)),
  },
};

const SKIP_KEYS = ["skippedMissingIdentity", "skippedDuplicate", "skippedRemoved", "skippedSuppressed", "skippedDoNotContact", "skippedContact", "skippedNotFound"] as const;

/** LinkedIn: people this call added whom another campaign already contacted or whose account already invited them. */
const noticesView = z.object({ alreadyContactedPeople: z.number(), excludedByAccountPeople: z.number() }).nullable();

const enrollView = z.object({ dryRun: z.boolean(), requested: z.number(), added: z.number(), wouldAdd: z.number().nullable(), skipped: z.record(z.string(), z.number()), notices: noticesView });

/** What the agent sends: get_campaign's shape, with its null subject and its `readToken`. */
const step = z.object({
  stepNumber: z.number().int(),
  kind: z.string(),
  subject: z.string().nullable().optional(),
  body: z.string(),
  waitDays: z.number().int(),
  readToken: z.string().nullable().optional(),
});
type SentStep = z.infer<typeof step>;

/** The same rules as the campaign page's own save: each channel's step kinds and lengths, with no tag an answer added. */
function stepsToSave(channel: Channel, steps: SentStep[]): unknown[] {
  const schema = channel === "email" ? stepSchema : linkedinStepSchema;
  // The schema keeps its own keys, so `readToken` stops here.
  return steps.map((s) => {
    const parsed = schema.safeParse({ ...s, subject: s.subject ? unfenced(s.subject) : undefined, body: unfenced(s.body) });
    if (!parsed.success) throw new ValidationError(`Step ${s.stepNumber}: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
    return parsed.data;
  });
}

export const draftCampaignTool = defineTool({
  name: "draft_campaign",
  title: "Draft campaign",
  description: [
    "Prepares a campaign; nothing here sends. `create` makes a draft (`channel`, `name`, optional `senderIds`; LinkedIn `personal`).",
    "`update` changes `name`, `steps` or `senderIds` of a draft or paused campaign; `steps` replace all steps (email: kind email, subject, body, waitDays; LinkedIn: invitation then messages), so read a step get_campaign marks `truncated` whole with `previewStep` and send its `readToken` with the edited step; text that looks like the cut copy is refused (`truncated_text`).",
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
      const steps = input.steps && stepsToSave(input.channel, input.steps);
      await agentUpdateCampaign(
        agentCampaignDeps(),
        actor,
        { channel: input.channel, campaignId, changesSenders: input.senderIds !== undefined },
        (saved) => {
          // `steps` replace every step, so a body get_campaign cut must not come back as the whole step.
          const old = saved.steps as Array<{ body: string }>;
          const cut = input.steps?.some((s) => old.some((o) => s.readToken !== bodyReadToken(o.body) && isCutCopy(s.body, o.body, STEP_BODY_CHARS)));
          if (cut) throw cutCopyRefusal("step body", "Read the step whole with get_campaign `previewStep` and send its `readToken` with your edit, or write the full text yourself.");
        },
        (tx) => writes.update(actor, campaignId, { name: input.name, steps, senderIds: input.senderIds }, tx),
      );
      return answer(campaignId, "Saved the campaign.");
    }
    if ((input.query === undefined) === (input.personIds === undefined)) throw new ValidationError("add_leads needs query or personIds, not both.");
    // The enroll use cases read a blank search as no filter, which would enroll every eligible lead.
    if (input.query !== undefined && input.query.trim() === "") throw new ValidationError("add_leads needs a query with words in it. To add everyone a search finds, name the people with personIds.");
    const dryRun = input.dryRun === true;
    const counts = await agentEnroll(agentCampaignDeps(), actor, { channel: input.channel, campaignId, launchToken: input.launchToken, dryRun }, (tx) =>
      input.personIds ? writes.picked(actor, campaignId, input.personIds, dryRun, tx) : writes.byQuery(actor, campaignId, input.query ?? "", dryRun, tx),
    );
    const skipped = Object.fromEntries(SKIP_KEYS.flatMap((key) => (counts[key] ? [[key.replace(/^skipped/, "").replace(/^./, (c) => c.toLowerCase()), counts[key] as number]] : [])));
    const added = counts.added ?? 0;
    const wouldAdd = dryRun ? (counts.wouldAdd ?? added) : null;
    // Read after the enroll commits: the reader takes its own connection, so inside the transaction it could wait on the one this call holds.
    const handled = input.personIds ?? counts.addedPersonIds ?? [];
    const notices = input.channel === "linkedin" && !dryRun ? await noticesForPeople(linkedinNoticeDeps().notices, actor.organizationId, campaignId, [...new Set(handled)]) : null;
    const enroll = { dryRun, requested: counts.requested ?? 0, added: dryRun ? 0 : added, wouldAdd, skipped, notices: notices && { alreadyContactedPeople: notices.alreadyContactedPeople, excludedByAccountPeople: notices.excludedByAccountPeople } };
    const contacted = notices && notices.alreadyContactedPeople > 0 ? ` ${notices.alreadyContactedPeople} of them were already contacted in another campaign.` : "";
    const summary = dryRun ? `Would add ${wouldAdd} lead(s). Call again without dryRun to add them.` : `Added ${added} lead(s).${contacted}`;
    return answer(campaignId, summary, enroll);
  },
});
