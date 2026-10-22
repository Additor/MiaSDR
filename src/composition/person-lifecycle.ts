import { appendPersonEvent, lockContactPolicy, lockPersonForDelete, personHandlingBlockers, personHandlingCounts } from "@/contexts/conversations/infrastructure/person-handling";
import { purgePersonHandling } from "@/contexts/conversations/infrastructure/person-purge";
import type { AddContactWithDealDeps } from "@/contexts/deals/application/deal-ports";
import { crmRead } from "@/contexts/deals/infrastructure/crm-read";
import { conversionDeps, dealsDeps } from "@/composition/deals";
import { dealCountsOfPerson, dealTitleParts, deleteClosedDealsOfPerson, lockDealsOfPerson } from "@/contexts/deals/infrastructure/person-deals";
import { addContact, type AddContactDeps, type AddContactInput, type AddContactResult } from "@/contexts/leads/application/add-contact";
import type { CompanyLifecycleDeps, CompanyMergePreviewDeps } from "@/contexts/leads/application/company-lifecycle";
import type { ContactDeleteDeps } from "@/contexts/leads/application/contact-delete";
import type { MakeContactDeps } from "@/contexts/leads/application/make-contact";
import { drizzleCompanyLifecycleStore } from "@/contexts/leads/infrastructure/drizzle-company-lifecycle-store";
import { drizzleContactDeleteStore } from "@/contexts/leads/infrastructure/drizzle-contact-delete-store";
import { drizzleContactStore, personTransaction } from "@/contexts/leads/infrastructure/drizzle-contact-store";
import { drizzleLeadsAudit } from "@/contexts/leads/infrastructure/drizzle-leads-audit";
import { conversionOutreach } from "@/contexts/outreach/infrastructure/drizzle-conversion-outreach";
import { keepEmailSuppressed, leadsInRunningCampaigns, personOutreachBlockers, personOutreachCounts, purgePersonOutreach } from "@/contexts/outreach/infrastructure/person-outreach";
import { drizzleOrganizationStore } from "@/contexts/tenancy/infrastructure/drizzle-organization-store";
import { retryOnce } from "@/platform/db/errors";
import type { Actor } from "@/shared/errors";

/*
 * The composition root of the people and company use cases of "Contacts and Companies CRUD" in docs/decisions.md. The use
 * cases and their ports live in `contexts/leads/application`, which imports neither deals nor outreach; this file wires those
 * ports to the callee-owned functions of conversations, deals and outreach. Routes import it, and no context does
 * (`src/architecture/context-dependencies.test.ts`).
 */

/** Add contact: the leads store and the `contact.added` event of conversations. */
export const addContactDeps: AddContactDeps = { contacts: drizzleContactStore, appendEvent: appendPersonEvent };

/** Add contact without a deal, in its own transaction with the conversion's lock timeout and one retry. */
export const createContact = (actor: Actor, input: AddContactInput): Promise<AddContactResult> =>
  retryOnce(() => personTransaction((tx) => addContact(addContactDeps, tx, actor, input)));

/** Add contact with "Also create a deal": the deals use case over the `CreateContact` port. */
export const addContactWithDealDeps = (): AddContactWithDealDeps => ({
  ...dealsDeps(),
  createContact: (tx, actor, input) => addContact(addContactDeps, tx, actor, input),
  dealTitleParts,
});

/** Make contact: the conversion's ports and the live enrollments of outreach. */
export const makeContactDeps: MakeContactDeps = {
  ...conversionDeps,
  liveEnrollmentSummary: conversionOutreach.liveEnrollmentSummary,
  transaction: personTransaction,
};

export const companyLifecycleDeps: CompanyLifecycleDeps = { companies: drizzleCompanyLifecycleStore, audit: drizzleLeadsAudit, transaction: personTransaction };

/** The merge preview counts the deals of the other company's contacts (deals) and its leads in running campaigns (outreach). */
export const companyMergePreviewDeps: CompanyMergePreviewDeps = {
  ...companyLifecycleDeps,
  mergeReads: {
    dealCounts: async (organizationId, companyId) => {
      const deals = await crmRead.dealsOfCompany(organizationId, companyId);
      return { openDeals: deals.filter((deal) => deal.stageKind === "open").length, deals: deals.length };
    },
    leadsInRunningCampaigns,
  },
};

/** Contact delete: each context deletes its own rows, in the order the leads use case holds. */
export const contactDeleteDeps: ContactDeleteDeps = {
  people: drizzleContactDeleteStore,
  handling: {
    lockPersonForDelete,
    lockContactPolicy,
    counts: personHandlingCounts,
    blockers: personHandlingBlockers,
    purge: purgePersonHandling,
  },
  deals: {
    list: async (_tx, organizationId, personId) =>
      (await crmRead.dealsOfPeople(organizationId, [personId])).map((deal) => ({ id: deal.id, title: deal.title, stageName: deal.stageName, stageKind: deal.stageKind })),
    lock: lockDealsOfPerson,
    counts: dealCountsOfPerson,
    deleteClosed: deleteClosedDealsOfPerson,
  },
  outreach: {
    counts: personOutreachCounts,
    blockers: personOutreachBlockers,
    keepEmailSuppressed,
    purge: purgePersonOutreach,
  },
  audit: drizzleLeadsAudit,
  transaction: personTransaction,
};

/** The organization's IANA time zone for the Contacts CSV dates, or null when the organization is gone (the export reads UTC). */
export async function organizationTimeZone(organizationId: string): Promise<string | null> {
  return (await drizzleOrganizationStore.get(organizationId))?.timeZone ?? null;
}
