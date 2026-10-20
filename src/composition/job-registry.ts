import { gridJobs } from "@/contexts/grid/infrastructure/enrichment-composition";
import { conversationJobs } from "@/contexts/conversations/ai/infrastructure/ai-composition";
import { sequenceJobs } from "@/contexts/conversations/after-reply/infrastructure/sequence-composition";
import { emailJobs } from "@/contexts/outreach/infrastructure/composition";
import { linkedinJobs } from "@/contexts/outreach/linkedin/infrastructure/linkedin-composition";
import { maintenanceJobs } from "@/platform/jobs/maintenance";
import type { Job } from "@/platform/jobs/types";
import { inboxFiling } from "./inbox-filing";

/** The composition point for background work: each bounded context contributes its jobs here. */
export function registeredJobs(): Job[] {
  return [...emailJobs(inboxFiling), ...linkedinJobs(inboxFiling), ...conversationJobs(), ...sequenceJobs(), ...gridJobs(), ...maintenanceJobs()];
}
