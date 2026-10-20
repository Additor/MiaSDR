import type { CompanyDeps } from "../application/company-management";
import type { importLeads } from "../application/import-leads";
import type { LeadDeps } from "../application/lead-ports";
import { defaultPhoneCountry } from "./default-phone-country";
import { drizzleCompanyStore } from "./drizzle-company-store";
import { drizzleLeadRepository } from "./drizzle-lead-repository";
import { drizzleLeadStore } from "./drizzle-lead-store";

/** The custom column store. The column use cases take it directly. */
export { drizzleCustomColumnStore as customColumnStore } from "./drizzle-custom-column-store";

export const leadDeps = (): LeadDeps => ({ leads: drizzleLeadRepository, defaultPhoneCountry });

export const companyDeps = (): CompanyDeps => ({ companies: drizzleCompanyStore });

/** Spreadsheet import and its dry run: the lead store plus the organization default phone country. */
export const leadImportDeps = (): Parameters<typeof importLeads>[0] => ({ store: drizzleLeadStore, defaultPhoneCountry });

/** Read models the lead and company screens call directly. */
export { leadFilterOptions, listLeads } from "./queries";
export { readLeadNeighbors, type LeadNeighbors } from "./lead-neighbors";
export { findCompanyByDomain, searchCompanies } from "./company-domain-store";
export { searchPeople } from "./people-directory";
