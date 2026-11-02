import { z } from "zod";
import { launchCampaign, previewLaunch } from "@/contexts/outreach/application/agent-campaigns";
import { LAUNCH_PURPOSES } from "@/contexts/outreach/domain/agent-campaign";
import { agentCampaignDeps } from "@/contexts/outreach/infrastructure/agent-campaign-composition";
import { LAUNCH_CARD_URI } from "./cards";
import { CHANNELS } from "./campaigns";
import { defineTool, READ_ONLY } from "./define";
import { appLinks, clip, fencedField, LONG_TEXT_CHARS, UNTRUSTED_NOTE, untrusted } from "./output";

const sender = z.object({ id: z.string(), name: z.string(), status: z.string(), dailyInviteLimit: z.number().nullable(), limitReachedUntil: z.string().nullable() });

export const previewCampaignLaunchTool = defineTool({
  name: "preview_campaign_launch",
  title: "Preview campaign launch",
  description: [
    "Checks what starting (`purpose: start`), resuming (`resume`) or adding leads to a running campaign (`enroll`) would do, and answers a `launchToken` for launch_campaign or draft_campaign add_leads.",
    "Pass `channel` and `campaignId`. The answer lists `problems` that would stop it, the senders, waiting leads, today's remaining agent enrolls and step 1 as it would go out. Show it to the person before you launch. Changes nothing.",
  ].join(" "),
  scope: "mcp:send",
  needs: "campaigns",
  annotations: READ_ONLY,
  card: LAUNCH_CARD_URI,
  input: z.object({ channel: z.enum(CHANNELS), campaignId: z.string(), purpose: z.enum(LAUNCH_PURPOSES) }),
  output: z.object({
    channel: z.enum(CHANNELS),
    campaignId: z.string(),
    purpose: z.enum(LAUNCH_PURPOSES),
    status: z.string(),
    problems: z.array(z.string()),
    senders: z.array(sender),
    allAccounts: z.boolean(),
    pendingLeads: z.number(),
    agentEnrollsLeftToday: z.number(),
    launchToken: z.string(),
    firstStep: z.object({ subject: z.string().nullable(), bodyText: z.string(), truncated: z.boolean(), leadName: z.string().nullable(), unresolved: z.array(z.object({ token: z.string(), reason: z.enum(["empty", "unknown"]) })) }),
    emptySubjectLeads: z.number().nullable(),
    estimatedDays: z.number().nullable(),
    appUrl: z.string(),
  }),
  async run({ actor, out }, input) {
    const preview = await previewLaunch(agentCampaignDeps(), actor, input);
    const appUrl = appLinks(out).campaign(preview.campaignId);
    const verdict = preview.problems.length === 0 ? "Nothing stops it." : `${preview.problems.length} problem(s): ${preview.problems.join(" ")}`;
    // The rendered step carries a lead's own values, so it comes fenced like get_campaign's preview.
    const body = clip(preview.firstStep.bodyText, LONG_TEXT_CHARS);
    const firstStep = { subject: fencedField(out, preview.firstStep.subject), bodyText: untrusted(out, "field", body.text), truncated: body.truncated, leadName: preview.firstStep.leadName, unresolved: preview.firstStep.unresolved };
    return {
      summary: `${preview.status} campaign, ${preview.pendingLeads} lead(s) waiting, ${preview.senders.length} sender(s). ${verdict}\n${UNTRUSTED_NOTE}`,
      structured: { ...preview, firstStep, appUrl },
    };
  },
});

export const launchCampaignTool = defineTool({
  name: "launch_campaign",
  title: "Launch campaign",
  description: [
    "Starts a draft campaign (`action: start`) or resumes a paused one (`resume`), as the token's person, with the `launchToken` from preview_campaign_launch for the same action.",
    "Campaign steps then send on their own to every waiting lead. A refusal names its `code`; `launch_token_stale` means the campaign changed, so preview again. Launch only when the person asked for it.",
  ].join(" "),
  scope: "mcp:send",
  needs: "campaigns",
  annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  input: z.object({ channel: z.enum(CHANNELS), campaignId: z.string(), action: z.enum(["start", "resume"]), launchToken: z.string() }),
  output: z.object({ channel: z.enum(CHANNELS), campaignId: z.string(), status: z.string(), emptySubjectLeads: z.number().nullable(), appUrl: z.string() }),
  buckets: () => ["write", "launch"],
  async run({ actor, out }, input) {
    const result = await launchCampaign(agentCampaignDeps(), actor, input);
    const skipped = result.emptySubjectLeads ? ` ${result.emptySubjectLeads} sampled lead(s) render an empty first subject and will be skipped.` : "";
    return {
      summary: `The campaign is ${result.status}; its steps now send on their own.${skipped}`,
      structured: { channel: input.channel, campaignId: input.campaignId, status: result.status, emptySubjectLeads: result.emptySubjectLeads, appUrl: appLinks(out).campaign(input.campaignId) },
    };
  },
});
