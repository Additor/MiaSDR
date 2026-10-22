import { importFoundPeople } from "@/contexts/people/application/found-people";
import { foundPeopleStore } from "@/contexts/people/infrastructure/composition";
import type { SearchLeadSink } from "../application/linkedin-search-ports";
import { enrollPeopleCounted } from "./drizzle-linkedin-campaign-store";

/** Leads for found people through the people context, then enrollment in the target campaign when the search has one. */
export const searchLeadSink: SearchLeadSink = {
  async importPeople(input) {
    const report = await importFoundPeople(
      { store: foundPeopleStore },
      { organizationId: input.organizationId, source: `linkedin_search:${input.searchId}`, people: input.people, tx: input.tx },
    );
    const ids = new Map([...report.people].map(([key, value]) => [key, value.personId]));
    // A found person who is already a contact stays a result of the search but is not enrolled; the count goes to the page stats.
    const enrolled = input.campaignId ? await enrollPeopleCounted(input.organizationId, input.campaignId, [...new Set(ids.values())], input.tx) : null;
    return { ids, skippedContact: enrolled?.skippedContact ?? 0 };
  },
};
