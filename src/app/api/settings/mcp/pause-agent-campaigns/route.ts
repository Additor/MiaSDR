import { pauseAgentStartedCampaigns } from "@/contexts/outreach/application/agent-campaigns";
import { agentCampaignDeps } from "@/contexts/outreach/infrastructure/agent-campaign-composition";
import { withAdmin } from "@/app/_lib/api";

/** Pauses every running campaign an agent started. Answers `{ paused }`. */
export const POST = () => withAdmin("Only an owner or admin can pause the campaigns agents started.", (actor) => pauseAgentStartedCampaigns(agentCampaignDeps(), actor));
