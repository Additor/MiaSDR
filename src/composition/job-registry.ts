import { gridJobs } from "@/contexts/grid/enrichment/infrastructure/enrichment-composition";
import { conversationJobs } from "@/contexts/conversations/ai/infrastructure/ai-composition";
import { followUpJobs } from "@/contexts/conversations/after-reply/infrastructure/follow-up-composition";
import { emailJobs } from "@/contexts/outreach/infrastructure/composition";
import { linkedinJobs } from "@/contexts/outreach/linkedin/infrastructure/linkedin-composition";
import { maintenanceJobs } from "@/platform/jobs/maintenance";
import type { Job } from "@/platform/jobs/types";
import { contactStop, inboxFiling, personTimeline } from "./inbox-filing";
import { rolloverSteps } from "./rollover-registry";
import { organizationTimeZones } from "@/contexts/tenancy/infrastructure/drizzle-organization-store";

/** The composition point for background work: each bounded context contributes its jobs here. */
export function registeredJobs(): Job[] {
  return [...emailJobs(inboxFiling, contactStop, personTimeline), ...linkedinJobs(inboxFiling), ...conversationJobs(), ...followUpJobs(), ...gridJobs(), ...maintenanceJobs({ steps: rolloverSteps(), zones: organizationTimeZones })];
}
