import { z } from "zod";
import { pauseSequenceRun, getRecordSequence } from "@/contexts/conversations/after-reply/application/sequences";
import { sequenceDeps } from "@/contexts/conversations/after-reply/infrastructure/sequence-composition";
import { changeCampaignStatus } from "@/contexts/outreach/application/campaign-management";
import { getSendPause, setSendPause } from "@/contexts/outreach/application/send-pause";
import { campaignDeps, emailRulesDeps, sendPauseDeps } from "@/contexts/outreach/infrastructure/composition";
import { changeLinkedInCampaignStatus } from "@/contexts/outreach/linkedin/application/linkedin-campaigns";
import { linkedinCampaignDeps } from "@/contexts/outreach/linkedin/infrastructure/linkedin-composition";
import { listMemberChoices } from "@/contexts/tenancy/application/member-directory";
import { memberDirectoryDeps } from "@/contexts/tenancy/infrastructure/member-composition";
import { ValidationError, type Actor } from "@/shared/errors";
import { campaignStatus, CHANNELS } from "./campaigns";
import { defineTool } from "./define";

const TARGETS = ["campaign", "follow_ups", "organization"] as const;
const OUTCOMES = ["paused", "already_paused", "nothing_to_pause", "not_started"] as const;
type Outcome = (typeof OUTCOMES)[number];

const PAUSE: Record<(typeof CHANNELS)[number], (actor: Actor, id: string) => Promise<unknown>> = {
  email: (actor, id) => changeCampaignStatus(campaignDeps(), actor, id, "paused"),
  linkedin: (actor, id) => changeLinkedInCampaignStatus(linkedinCampaignDeps(), actor, id, "paused"),
};

const SUMMARY: Record<Outcome, string> = {
  paused: "Paused.",
  already_paused: "It was already paused.",
  nothing_to_pause: "Nothing is running there to pause.",
  not_started: "The campaign has not started, so nothing is sending.",
};

async function pauseCampaign(actor: Actor, channel: (typeof CHANNELS)[number], campaignId: string): Promise<Outcome> {
  const status = await campaignStatus(actor, channel, campaignId);
  if (status === "draft") return "not_started";
  if (status === "paused") return "already_paused";
  if (status !== "active") return "nothing_to_pause";
  await PAUSE[channel](actor, campaignId);
  return "paused";
}

async function pauseFollowUps(actor: Actor, recordId: string): Promise<Outcome> {
  const { run } = await getRecordSequence(sequenceDeps(), actor, recordId);
  if (!run) return "nothing_to_pause";
  if (run.status === "paused") return "already_paused";
  if (run.status !== "active") return "nothing_to_pause";
  await pauseSequenceRun(sequenceDeps(), actor, recordId);
  return "paused";
}

/** The name the pause banner shows: the person, and the agent token that acted for them. */
async function pausedBy(actor: Actor): Promise<string | null> {
  if (!actor.via) return null;
  const person = (await listMemberChoices(memberDirectoryDeps(), actor)).find((m) => m.userId === actor.userId)?.name;
  return person ? `${person}'s agent (${actor.via.tokenName})` : `${actor.via.tokenName} (agent)`;
}

async function pauseOrganization(actor: Actor): Promise<Outcome> {
  if (await getSendPause(emailRulesDeps(), actor)) return "already_paused";
  const byName = await pausedBy(actor);
  await setSendPause(sendPauseDeps(), actor, { paused: true, byName, now: new Date() });
  return "paused";
}

export const pauseSendingTool = defineTool({
  name: "pause_sending",
  title: "Pause sending",
  description: [
    "Stops sending; it never resumes. `campaign` pauses one campaign (`channel`, `campaignId`); `follow_ups` pauses the follow-ups of one reply handling (`recordId`);",
    "`organization` pauses every campaign email and LinkedIn action of the organization (owners and admins). A person resumes in MiaSDR.",
    "The answer says `paused`, `already_paused`, `nothing_to_pause` or `not_started`.",
  ].join(" "),
  scope: "mcp:write",
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  input: z.object({ target: z.enum(TARGETS), channel: z.enum(CHANNELS).optional(), campaignId: z.string().optional(), recordId: z.string().optional() }),
  output: z.object({ target: z.enum(TARGETS), outcome: z.enum(OUTCOMES) }),
  async run({ actor }, input) {
    let outcome: Outcome;
    switch (input.target) {
      case "campaign":
        if (!input.channel || !input.campaignId) throw new ValidationError("campaign needs channel and campaignId.");
        outcome = await pauseCampaign(actor, input.channel, input.campaignId);
        break;
      case "follow_ups":
        if (!input.recordId) throw new ValidationError("follow_ups needs recordId.");
        outcome = await pauseFollowUps(actor, input.recordId);
        break;
      case "organization":
        outcome = await pauseOrganization(actor);
        break;
    }
    return { summary: SUMMARY[outcome], structured: { target: input.target, outcome } };
  },
});
