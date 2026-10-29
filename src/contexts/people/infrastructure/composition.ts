import type { CompanyDeps } from "../application/company-management";
import type { importLeads } from "../application/import-leads";
import { defaultPhoneCountry } from "./default-phone-country";
import { drizzleCompanyStore } from "./drizzle-company-store";
import { drizzleLeadStore } from "./drizzle-lead-store";

/** The custom column store. The column use cases take it directly. */
export { drizzleCustomColumnStore as customColumnStore } from "./drizzle-custom-column-store";

export const companyDeps = (): CompanyDeps => ({ companies: drizzleCompanyStore });

/** Spreadsheet import and its dry run: the lead store plus the organization default phone country. */
export const leadImportDeps = (): Parameters<typeof importLeads>[0] => ({ store: drizzleLeadStore, defaultPhoneCountry });

/**
 * The lead reads that filter, built over the activity conditions of the lead filter. `src/composition/leads.ts` passes
 * `activityCondition` (`src/read-models/lead-activity.ts`) to each and hands out the result.
 */
export { createLeadDeleteStore, createLeadRepository } from "./drizzle-lead-repository";
export { createListLeads, type ActivityCondition, type ListLeads } from "./queries";
export { createReadLeadNeighbors, type LeadNeighbors, type ReadLeadNeighbors } from "./lead-neighbors";
export { defaultPhoneCountry };

/** Read models the company screens call directly. */
export { findCompanyByDomain, searchCompanies } from "./company-domain-store";
export { searchPeople } from "./people-directory";
/** Reachability of a page of person ids (email, LinkedIn, do not contact, suppression). Pages call it directly. */
export { readReachability } from "./reachability";

/** Where a LinkedIn search hands the people it found: outreach's search sink calls `importFoundPeople` with it. */
export { drizzleFoundPeopleStore as foundPeopleStore } from "./drizzle-found-people-store";
