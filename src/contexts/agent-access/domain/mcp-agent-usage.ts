import { ConflictError } from "@/shared/errors";
import type { McpSettings } from "./mcp-settings";
import type { AgentActionRefusal, AgentSpendPolicy } from "./mcp-policy";

/**
 * The organization's daily limits on what agents spend and cannot undo. Each kind reserves against its own limit before
 * the action runs. No I/O.
 */
export const AGENT_USAGE_KINDS = ["spend_cents", "search_leads", "irreversible"] as const;
export type AgentUsageKind = (typeof AGENT_USAGE_KINDS)[number];

export const AGENT_USAGE_REFUSALS = {
  agent_spend_off: "Agents cannot spend in this organization with this token. An owner or admin sets a daily limit under Settings, Organization; a token made before spending was last turned off needs replacing.",
  agent_irreversible_off: "Agents cannot take actions a person cannot undo in this organization with this token. An owner or admin sets a daily limit under Settings, Organization; a token made before they were last turned off needs replacing.",
  agent_spend_cap: "This would pass today's limit on what agents spend on enrichment for this organization. It resets at midnight UTC.",
  agent_search_cap: "This would pass today's limit on the LinkedIn search results agents ask for in this organization. It resets at midnight UTC.",
  agent_irreversible_cap: "This would pass today's limit on actions agents cannot undo in this organization. It resets at midnight UTC.",
} as const;
export type AgentUsageRefusal = keyof typeof AGENT_USAGE_REFUSALS;

export const agentUsageRefusal = (code: AgentUsageRefusal, retryAfterSeconds?: number) =>
  new ConflictError(AGENT_USAGE_REFUSALS[code], { code, ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds: Math.max(1, Math.ceil(retryAfterSeconds)) }) });

const CAP_REFUSAL: Record<AgentUsageKind, AgentUsageRefusal> = { spend_cents: "agent_spend_cap", search_leads: "agent_search_cap", irreversible: "agent_irreversible_cap" };

/** The refusal for a reservation over today's limit, with the wait until midnight UTC. */
export const agentUsageCapRefusal = (kind: AgentUsageKind, now: Date) => agentUsageRefusal(CAP_REFUSAL[kind], secondsToUtcMidnight(now));

const DAY_MS = 86_400_000;
const secondsToUtcMidnight = (now: Date) => (Math.floor(now.getTime() / DAY_MS) * DAY_MS + DAY_MS - now.getTime()) / 1000;

/** The UTC day a reservation counts in, as the `mcp_agent_usage.day` column holds it. */
export const agentUsageDay = (now: Date): string => now.toISOString().slice(0, 10);

/** The limit a kind reserves against, or the refusal when the policy does not allow it now. */
export function agentUsageLimit(kind: AgentUsageKind, gate: { spend: AgentSpendPolicy; irreversible: AgentActionRefusal | null; settings: McpSettings }): number | AgentUsageRefusal {
  if (kind === "irreversible") return gate.irreversible === null ? gate.settings.agentIrreversiblePerDay : "agent_irreversible_off";
  if (kind === "spend_cents") return gate.spend.enrichment ? gate.settings.agentSpendCentsPerDay : "agent_spend_off";
  return gate.spend.search ? gate.settings.agentSearchLeadsPerDay : "agent_spend_off";
}
