import { createHash } from "node:crypto";
import { ConflictError } from "@/shared/errors";

/**
 * The rules an agent's campaign start, resume or enroll meets on top of a person's (docs/decisions.md, "Agent
 * campaigns"). Each refusal is a 409 with its reason as `code`. No I/O.
 */
export const AGENT_CAMPAIGN_REFUSALS = {
  agent_campaigns_off: "Agents cannot start campaigns or add leads to running ones in this organization with this token. An owner or admin allows it under Settings, Organization (Replies and campaigns).",
  agent_send_paused: "Sending is paused for this organization. Agents start nothing until a person resumes it.",
  launch_token_stale: "The campaign changed since the preview: its steps, senders, status or waiting leads. Run preview_campaign_launch again and check the new preview.",
  agent_enroll_cap: "This would pass today's limit on leads agents enroll for this organization. It resets at midnight UTC.",
  agent_sender_not_owned: "An agent starts a Personal campaign only from LinkedIn accounts its token's person owns, named as the campaign's senders. The account's owner starts it, or an admin sets the owner under Settings, LinkedIn.",
  agent_sender_change_active: "An agent changes the senders of a campaign only while it is not running. Pause it first.",
  agent_resume_person_paused: "A person paused this campaign, so only a person resumes it in MiaSDR.",
  agent_complete_person_paused: "A person paused this campaign, so only a person completes it in MiaSDR.",
} as const;

export type AgentCampaignRefusal = keyof typeof AGENT_CAMPAIGN_REFUSALS;

export const agentCampaignRefusal = (code: AgentCampaignRefusal, retryAfterSeconds?: number) =>
  new ConflictError(AGENT_CAMPAIGN_REFUSALS[code], { code, ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds: Math.max(1, Math.ceil(retryAfterSeconds)) }) });

/** What a launch token is for. A start or resume token also holds how many leads waited at the preview. */
export const LAUNCH_PURPOSES = ["start", "resume", "enroll"] as const;
export type LaunchPurpose = (typeof LAUNCH_PURPOSES)[number];

/** A sender as the token sees it: the account and whether it can send now. */
export interface LaunchSender {
  id: string;
  status: string;
}

export interface LaunchState {
  channel: "email" | "linkedin";
  /** The campaign: a token from one campaign means nothing on another with the same steps. */
  id: string;
  status: string;
  steps: unknown;
  /** The senders the campaign sends from: its own list, or every account of the channel when the list is empty. */
  senders: readonly LaunchSender[];
}

const VERSION = "lt1";

function digest(purpose: LaunchPurpose, state: LaunchState, pending: number | null): string {
  const senders = [...state.senders].map((s) => `${s.id}:${s.status}`).sort();
  return createHash("sha256")
    .update(JSON.stringify([purpose, state.id, state.channel, state.status, state.steps, senders, pending]))
    .digest("base64url")
    .slice(0, 32);
}

/**
 * The token a preview hands out and a launch or an active enroll checks: the state the agent saw. It catches a change
 * in between, not a forgery: every rule still runs at the launch. A start or resume token carries the waiting leads.
 */
export function launchToken(purpose: LaunchPurpose, state: LaunchState, pending: number): string {
  const held = purpose === "enroll" ? null : pending;
  return [VERSION, purpose, held ?? "-", digest(purpose, state, held)].join(".");
}

/**
 * Whether `token` still matches the campaign for `purpose`. A start or resume token also fails when more leads wait
 * now than at the preview; fewer is fine, as the campaign may have finished some or a person removed them.
 */
export function launchTokenMatches(token: string, purpose: LaunchPurpose, state: LaunchState, pending: number): boolean {
  const [version, tokenPurpose, held, hash] = token.split(".");
  if (version !== VERSION || tokenPurpose !== purpose || !hash) return false;
  if (purpose === "enroll") return held === "-" && hash === digest(purpose, state, null);
  const previewed = Number(held);
  if (!Number.isInteger(previewed) || previewed < 0 || pending > previewed) return false;
  return hash === digest(purpose, state, previewed);
}
