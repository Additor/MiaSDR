import type { AgentCampaignDeps } from "../application/agent-campaigns";
import { linkedinCampaignDeps } from "../linkedin/infrastructure/linkedin-composition";
import { campaignDeps } from "./composition";
import { drizzleAgentCampaignStore } from "./drizzle-agent-campaign-store";

/** Agent campaign starts and enrolls over MCP: both channels' campaign use cases under the agent rules. */
export const agentCampaignDeps = (): AgentCampaignDeps => ({ store: drizzleAgentCampaignStore, email: campaignDeps(), linkedin: linkedinCampaignDeps(), now: () => new Date() });
