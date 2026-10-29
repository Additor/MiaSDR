import type { LeadActivityDeps } from "@/contexts/outreach/application/read-lead-activity";
import type { LeadDeps } from "@/contexts/people/application/lead-ports";
import {
  createLeadDeleteStore,
  createLeadRepository,
  createListLeads,
  createReadLeadNeighbors,
  defaultPhoneCountry,
  readReachability,
} from "@/contexts/people/infrastructure/composition";
import { activityCondition, readLeadDetailActivity, readLeadStatuses } from "@/read-models/lead-activity";

/*
 * The lead reads, over one definition of each lead fact ("Read models" in docs/decisions.md). The people context builds
 * them from its own tables and the read-model functions it takes as arguments; this file passes `activityCondition`, so
 * the list, count, matching ids, export, delete by filter and previous/next see the same set, and `readLeadDetailActivity`
 * for the lead and contact pages.
 */

/** The lead repository: people's fields and writes, with the activity filter and the detail's enrollments, sends and conversation. */
export const leadRepository = createLeadRepository({ activity: activityCondition, detailActivity: readLeadDetailActivity });

/** The people side of the lead delete. `person-lifecycle.ts` wires it into `leadDeleteDeps`. */
export const leadDeleteStore = createLeadDeleteStore(activityCondition);

export const leadDeps = (): LeadDeps => ({ leads: leadRepository, defaultPhoneCountry });

/** The lead list page. */
export const listLeads = createListLeads(activityCondition);

/** The previous and next links of the lead page, in the list's filter and order. */
export const readLeadNeighbors = createReadLeadNeighbors(activityCondition);

/** The reads of `readLeadActivity`: the lead list, the lead page and the contact page pass it. */
export const leadActivityDeps = (): LeadActivityDeps => ({ readStatuses: readLeadStatuses, readReach: readReachability });

export type { LeadNeighbors } from "@/contexts/people/infrastructure/composition";
