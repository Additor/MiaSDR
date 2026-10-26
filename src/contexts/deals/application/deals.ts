/*
 * Deals use cases ("Leads and CRM" in docs/decisions.md). Any organization member may use them; the one limit
 * is the personal-campaign rule of the conversion. `createDealFromLead` runs the leads conversion (`ConvertLead`) and the deal
 * insert in one transaction, so both commit or neither does. `addContactWithDeal` does the same with Add contact (leads
 * `addContact` through `CreateContact`).
 *
 * The conversion meets reply ingest, suppression and the send engine on the same person. Its transaction runs with a 5 s lock
 * timeout and runs once more on a deadlock (40P01) or a lock timeout (55P03); a second failure answers 409 `try_again`.
 */

export { BOARD_LIMIT, BULK_TIME_BUDGET_MS, CLOSED_WINDOW_DAYS, CRM_PAGE_SIZE, MAX_BOARD_LIMIT, MAX_BULK_CONVERT_IDS, MAX_IDEMPOTENCY_KEY, PersonalCampaignError, isUuid } from "./deal-input";
export type { CreateDealInput } from "./deal-input";
export { CONTACT_GONE, addContactWithDeal, createDealForContact, createDealFromLead, createDealsFromLeads } from "./deal-create";
export type { AddContactWithDealInput, BulkCreateResult, BulkSkipReason, CreateDealResult } from "./deal-create";
export { deleteDeal, moveDealStage, updateDeal } from "./deal-edit";
export type { UpdateDealInput } from "./deal-edit";
export { CONTACT_EXPORT_HEADER, board, dealSummaryForPeople, exportContactsCsv, getCompany, getDeal, listCompanies, listContactIds, listContacts } from "./deal-reads";
export type { Board, BoardCard, BoardColumn, BoardInput, ContactListInput, ContactListItem, DealOwner, DealSource, DealView, PersonDealSummary } from "./deal-reads";
