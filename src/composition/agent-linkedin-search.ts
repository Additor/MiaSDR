import { agentCampaignRefusal } from "@/contexts/outreach/domain/agent-campaign";
import { agentCampaignDeps } from "@/contexts/outreach/infrastructure/agent-campaign-composition";
import { createAgentLinkedInSearch } from "@/contexts/outreach/linkedin/application/linkedin-search";
import { linkedinSearchDeps } from "@/contexts/outreach/linkedin/infrastructure/linkedin-composition";
import { withAgentUsage } from "@/contexts/agent-access/application/mcp-agent-usage";
import { agentUsageDeps } from "@/contexts/agent-access/infrastructure/mcp-composition";
import type { Actor } from "@/shared/errors";

/**
 * An agent's LinkedIn search: outreach holds the rules, agent access the daily limit on results asked for. Each search counts
 * whole when it is created, since results arrive later. A search spends the accounts' daily allowance, so it waits with
 * the rest of outbound while sending is paused.
 */
export async function createAgentSearch(actor: Actor, input: { name: string; url: string; maxResults: number }): Promise<{ id: string }> {
  const campaigns = agentCampaignDeps();
  if (await campaigns.store.transaction((tx) => campaigns.store.sendPaused(tx, actor.organizationId))) throw agentCampaignRefusal("agent_send_paused");
  return withAgentUsage(agentUsageDeps(), actor, { kind: "search_leads", amount: input.maxResults }, () => createAgentLinkedInSearch(linkedinSearchDeps(), actor, input));
}
