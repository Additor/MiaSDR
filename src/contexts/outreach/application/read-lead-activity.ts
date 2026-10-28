import { leadContactPoints, type LeadContactPoints } from "@/contexts/people/domain/lead-activity";
import { NEW_LEAD_STATUS, type LeadStatus, type ReadLeadStatuses } from "../domain/lead-status";
import { NO_REACH, type Reachability, type ReadReachability } from "@/contexts/people/domain/reachability";

/** One person's activity: the lead status (null for a contact, which carries no status), the reachability and the contact points. */
export interface LeadActivity {
  status: LeadStatus | null;
  reach: Reachability;
  contact: LeadContactPoints;
}

export interface LeadActivityDeps {
  /** The batched lead status read. The pages pass `readLeadStatuses`. */
  readStatuses: ReadLeadStatuses;
  /** The batched reachability read. The pages pass `readReachability`. */
  readReach: ReadReachability;
}

export interface LeadActivitySource {
  id: string;
  /** "lead" or "contact". A contact gets no status. */
  lifecycle: string;
  email: string | null;
  linkedinSlug: string | null;
  linkedinUrl: string | null;
}

/**
 * Status, reach and contact points of a set of people, keyed by person id. The lead list calls it for one page and the
 * lead page for its one id, so both show the same state. The people context owns the contact points, which come from the
 * rows the caller already read, so they cost no query. The status and reach come from one call to each read for the
 * whole set; contacts skip the status read. A lead with no outreach is new. Every id of the set has an entry.
 */
export async function readLeadActivity(deps: LeadActivityDeps, organizationId: string, people: readonly LeadActivitySource[]): Promise<Map<string, LeadActivity>> {
  const result = new Map<string, LeadActivity>();
  if (people.length === 0) return result;
  const ids = people.map((person) => person.id);
  const leadIds = people.filter((person) => person.lifecycle !== "contact").map((person) => person.id);
  const [statuses, reach] = await Promise.all([
    leadIds.length > 0 ? deps.readStatuses(organizationId, leadIds) : new Map<string, LeadStatus>(),
    deps.readReach(organizationId, ids),
  ]);
  for (const person of people) {
    result.set(person.id, {
      status: person.lifecycle === "contact" ? null : (statuses.get(person.id) ?? NEW_LEAD_STATUS),
      reach: reach.get(person.id) ?? NO_REACH,
      contact: leadContactPoints(person),
    });
  }
  return result;
}
