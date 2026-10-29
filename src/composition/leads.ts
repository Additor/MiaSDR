import type { LeadDeps } from "@/contexts/people/application/lead-ports";
import {
  createLeadDeleteStore,
  createLeadRepository,
  createListLeads,
  createReadLeadNeighbors,
  defaultPhoneCountry,
} from "@/contexts/people/infrastructure/composition";
import { activityCondition } from "@/read-models/lead-activity";

/*
 * The lead reads that filter, over one definition of the lead filter ("Read models" in docs/decisions.md). The people
 * context builds them from its own conditions and the activity conditions it takes as an argument; this file passes
 * `activityCondition`, so the list, count, matching ids, export, delete by filter and previous/next see the same set.
 */

export const leadRepository = createLeadRepository(activityCondition);

/** The people side of the lead delete. `person-lifecycle.ts` wires it into `leadDeleteDeps`. */
export const leadDeleteStore = createLeadDeleteStore(activityCondition);

export const leadDeps = (): LeadDeps => ({ leads: leadRepository, defaultPhoneCountry });

/** The lead list page. */
export const listLeads = createListLeads(activityCondition);

/** The previous and next links of the lead page, in the list's filter and order. */
export const readLeadNeighbors = createReadLeadNeighbors(activityCondition);

export type { LeadNeighbors } from "@/contexts/people/infrastructure/composition";
