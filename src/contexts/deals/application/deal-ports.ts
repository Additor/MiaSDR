import type { DbHandle } from "@/platform/db/client";
import type { PersonEventInput } from "@/contexts/conversations/application/person-ports";
import type { AddContactInput, AddContactResult } from "@/contexts/leads/application/add-contact";
import type { ConvertInput, ConvertResult } from "@/contexts/leads/application/convert-to-contact";
import type { Actor } from "@/shared/errors";
import type { ConversionOutreach } from "@/contexts/outreach/application/conversion";
import type { DealStageKind } from "../domain/stages";

/*
 * Ports of the deals context ("Leads and CRM" in docs/decisions.md). Deals owns `deals` and `deal_stages`. Everything
 * else arrives through a port: the conversion is the leads use case `convertToContact` (`ConvertLead`), the person's history
 * is conversations' `appendPersonEvent`, the replied enrollment and campaign names are outreach reads, and the screens read
 * through `CrmRead`, an explicit read model. `deals-composition.ts` wires all of them. Every call carries the organization.
 */

export interface DealStage {
  id: string;
  name: string;
  kind: DealStageKind;
  position: number;
}

export interface StoppedCounts {
  enrollments: number;
  runs: number;
  drafts: number;
}

export interface DealRow {
  id: string;
  personId: string;
  stageId: string;
  stageKind: DealStageKind;
  title: string;
  ownerUserId: string | null;
  amountMinor: number | null;
  currency: string | null;
  /** YYYY-MM-DD. */
  expectedCloseOn: string | null;
  closedAt: Date | null;
  lostReason: string | null;
  stageChangedAt: Date;
  sourceEnrollmentId: string | null;
  version: number;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface NewDeal {
  organizationId: string;
  personId: string;
  stageId: string;
  stageKind: DealStageKind;
  title: string;
  ownerUserId: string | null;
  amountMinor: number | null;
  currency: string | null;
  expectedCloseOn: string | null;
  closedAt: Date | null;
  lostReason: string | null;
  stageChangedAt: Date;
  sourceEnrollmentId: string | null;
  idempotencyKey: string | null;
  createdBy: string | null;
}

export type DealPatch = Partial<
  Pick<DealRow, "title" | "ownerUserId" | "amountMinor" | "currency" | "expectedCloseOn" | "stageId" | "stageKind" | "closedAt" | "lostReason" | "stageChangedAt">
>;

export interface AuditEntry {
  organizationId: string;
  actorUserId: string | null;
  action: string;
  entityType?: string;
  entityId?: string;
  meta?: Record<string, unknown>;
}

/** Writes and transactional reads of `deals` and `deal_stages`. */
export interface DealStore {
  /**
   * The organization's stages in position order. An organization with none gets the defaults: an unlocked count first, and
   * only when it is zero the pipeline lock and an insert that skips names already there. With stages, it takes no lock.
   */
  ensureStages(tx: DbHandle, organizationId: string): Promise<DealStage[]>;
  /** Stages in position order, with no write. */
  listStages(organizationId: string, handle?: DbHandle): Promise<DealStage[]>;
  /** Deals per stage id. */
  stageDealCounts(organizationId: string, handle?: DbHandle): Promise<Map<string, number>>;
  /** The deal an earlier call with this key created for the person, and what that call stopped. */
  byIdempotencyKey(tx: DbHandle, organizationId: string, personId: string, key: string): Promise<{ dealId: string; stopped: StoppedCounts } | null>;
  /** The person's primary deal, in the order of `primaryDeal` (domain/primary-deal.ts): open first, newest, higher id. */
  primaryDealIdOfPerson(tx: DbHandle, organizationId: string, personId: string): Promise<string | null>;
  /** Null when a deal with the same idempotency key exists for the person (a concurrent call won). */
  insert(tx: DbHandle, deal: NewDeal): Promise<DealRow | null>;
  /** The deal `FOR UPDATE`, or null when it is not in the organization. */
  lock(tx: DbHandle, organizationId: string, dealId: string): Promise<DealRow | null>;
  /** Applies the patch and adds one to `version`. */
  update(tx: DbHandle, organizationId: string, dealId: string, patch: DealPatch, now: Date): Promise<DealRow>;
  delete(tx: DbHandle, organizationId: string, dealId: string): Promise<void>;

  /** Takes the organization's pipeline lock (transaction-scoped) and returns its stages in position order. */
  lockStages(tx: DbHandle, organizationId: string): Promise<DealStage[]>;
  insertStage(tx: DbHandle, organizationId: string, stage: { name: string; kind: DealStageKind; position: number }): Promise<DealStage>;
  renameStage(tx: DbHandle, organizationId: string, stageId: string, name: string, now: Date): Promise<void>;
  /** Writes the positions in one transaction; the position key is checked at commit, so a swap works. */
  setPositions(tx: DbHandle, organizationId: string, positions: Array<{ id: string; position: number }>, now: Date): Promise<void>;
  deleteStage(tx: DbHandle, organizationId: string, stageId: string): Promise<void>;
  audit(tx: DbHandle, entry: AuditEntry): Promise<void>;
}

export interface UnitOfWork {
  /** Runs `fn` in one transaction. `lockTimeout` sets `SET LOCAL lock_timeout = '5s'` first. */
  run<T>(fn: (tx: DbHandle) => Promise<T>, options?: { lockTimeout?: boolean }): Promise<T>;
}

/** The leads use case `convertToContact`, bound to its ports. Runs in the caller's transaction. */
export type ConvertLead = (tx: DbHandle, input: ConvertInput) => Promise<ConvertResult>;

/**
 * The leads use case `addContact`, bound to its ports by the composition root ("Contacts and Companies CRUD" in docs/decisions.md). Runs in the caller's transaction, so `addContactWithDeal` commits the contact and its deal together.
 */
export type CreateContact = (tx: DbHandle, actor: Actor, input: AddContactInput) => Promise<AddContactResult>;

/** The name and company of a person, read in the caller's transaction, for a deal's default title. Null when the person is not there. */
export type DealTitleParts = (tx: DbHandle, organizationId: string, personId: string) => Promise<{ name: string | null; companyName: string | null } | null>;

/** A person as the deal screens show them, any lifecycle. */
export interface DealPerson {
  id: string;
  name: string | null;
  email: string | null;
  /** The profile link of the reach icons comes from these. */
  linkedinSlug: string | null;
  linkedinUrl: string | null;
  title: string | null;
  companyId: string | null;
  companyName: string | null;
  lifecycle: string;
  convertedAt: Date | null;
  doNotContact: boolean;
  suppressed: boolean;
}

export interface DealPeople {
  /** People of the organization by id. Unknown ids and other organizations' ids have no entry. */
  summaries(organizationId: string, ids: readonly string[]): Promise<Map<string, DealPerson>>;
}

export type DealOutreach = Pick<ConversionOutreach, "liveEnrollmentSummary" | "latestRepliedEnrollment" | "enrollmentSources">;

export interface DealEvents {
  append(tx: DbHandle, input: PersonEventInput): Promise<void>;
}

export interface DealMembers {
  isMember(organizationId: string, userId: string): Promise<boolean>;
  /** Current members by user id. A deal owner missing here left the organization ("Former member"). */
  names(organizationId: string): Promise<Map<string, string>>;
}

// ---- Read model ----------------------------------------------------------------------------------------------

export interface BoardCardRow {
  id: string;
  title: string;
  personId: string;
  personName: string | null;
  companyName: string | null;
  amountMinor: number | null;
  currency: string | null;
  ownerUserId: string | null;
  expectedCloseOn: string | null;
  closedAt: Date | null;
  stageChangedAt: Date;
  sourceEnrollmentId: string | null;
  version: number;
}

export interface BoardColumnRow {
  stageId: string;
  /** Deals in the column under the filters (Won and Lost: the last 30 days unless `showAll`). */
  total: number;
  /**
   * Sum per currency of the same deals; amounts of different currencies never add up. A decimal string, because a sum of
   * amounts that each fit 2^53 - 1 can pass it.
   */
  amounts: Array<{ currency: string; amountMinor: string }>;
  cards: BoardCardRow[];
  /** Pass back as `cursor` for the next cards of this column, null at the end. */
  nextCursor: string | null;
}

export interface BoardQuery {
  stageIds: string[];
  /** A user id, or "none" for deals without an owner. */
  owner?: string;
  q?: string;
  limit: number;
  cursor?: string;
  /** Won and Lost columns show deals closed on or after this instant; null shows all. */
  closedSince: Date | null;
}

export interface DealViewRow extends DealRow {
  stageName: string;
  stagePosition: number;
}

export interface PersonDealRow {
  id: string;
  personId: string;
  title: string;
  stageId: string;
  stageName: string;
  stageKind: DealStageKind;
  amountMinor: number | null;
  currency: string | null;
  closedAt: Date | null;
  stageChangedAt: Date;
  createdAt: Date;
}

export interface ContactListRow {
  id: string;
  name: string | null;
  email: string | null;
  linkedinSlug: string | null;
  linkedinUrl: string | null;
  title: string | null;
  companyId: string | null;
  companyName: string | null;
  convertedAt: Date;
  openDeals: number;
  lastActivityAt: Date | null;
  doNotContact: boolean;
  /** The person's primary deal (`primaryDeal`): the most recent open deal, else the most recent deal; null when the person has no deal. */
  latestDeal: ContactLatestDealRow | null;
}

export interface ContactLatestDealRow {
  id: string;
  stageId: string;
  stageName: string;
  stageKind: DealStageKind;
  ownerUserId: string | null;
}

export interface CompanyListRow {
  id: string;
  name: string | null;
  domain: string;
  linkedinUrl: string | null;
  contacts: number;
  openDeals: number;
  /** The latest activity among the company's contacts, by the rule of the Contacts list. */
  lastActivityAt: Date | null;
  /** Sum per currency of the open deals' amounts, as decimal strings (`BoardColumnRow.amounts`). */
  openAmounts: Array<{ currency: string; amountMinor: string }>;
}

export interface CompanyDetailRow {
  id: string;
  name: string | null;
  domain: string;
  linkedinUrl: string | null;
  custom: Record<string, unknown>;
  createdAt: Date;
  /** Bumped by every company write; the merge and the company delete send it back. */
  version: number;
  /** Set once the company is listed in Companies without a contact (M3); null for a company listed only by its contacts. */
  crmListedAt: Date | null;
  /** Other domains, oldest first. `mergedName` is the name of the company a merge removed, when known. */
  aliases: Array<{ domain: string; mergedName: string | null }>;
  /** People attached to the company, by lifecycle. */
  contacts: number;
  leads: number;
}

/** One row of the Contacts CSV. Dates are ISO dates (YYYY-MM-DD) in the organization's time zone. */
export interface ContactExportRow {
  id: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  linkedinSlug: string | null;
  linkedinUrl: string | null;
  title: string | null;
  companyName: string | null;
  companyDomain: string | null;
  /** The owner of the latest deal (`ContactListRow.latestDeal`). */
  ownerUserId: string | null;
  latestDealTitle: string | null;
  latestStageName: string | null;
  openDeals: number;
  contactSince: string;
  lastActivityOn: string | null;
  custom: Record<string, unknown>;
}

/** What the Contacts CSV holds: the contacts that match the list filter, or the ticked ids (contacts only). */
export type ContactExportScope = { filter: ContactFilter & { q?: string } } | { ids: readonly string[] };

export type ContactSort = "converted" | "name" | "activity";

/** Filters of the Contacts list. Both apply to the contact's latest deal (`ContactListRow.latestDeal`). */
export interface ContactFilter {
  /** A user id, or "none" for a latest deal without an owner. */
  owner?: string;
  stageId?: string;
}
export type CompanySort = "name" | "contacts" | "open_deals";

export interface CrmRead {
  board(organizationId: string, query: BoardQuery): Promise<BoardColumnRow[]>;
  deal(organizationId: string, dealId: string): Promise<DealViewRow | null>;
  dealsOfPeople(organizationId: string, personIds: readonly string[]): Promise<PersonDealRow[]>;
  dealsOfCompany(organizationId: string, companyId: string): Promise<PersonDealRow[]>;
  contacts(organizationId: string, query: ContactFilter & { q?: string; sort: ContactSort; page: number; pageSize: number }): Promise<{ rows: ContactListRow[]; total: number }>;
  companies(organizationId: string, query: { q?: string; sort: CompanySort; page: number; pageSize: number }): Promise<{ rows: CompanyListRow[]; total: number }>;
  company(organizationId: string, companyId: string): Promise<CompanyDetailRow | null>;
  /** The company's contacts (leads excluded), newest conversion first. */
  contactsOfCompany(organizationId: string, companyId: string): Promise<ContactListRow[]>;
  /** Per company: contacts and open deals. Companies without contacts have no entry. */
  companySummaries(organizationId: string, companyIds: readonly string[]): Promise<Map<string, { contacts: number; openDeals: number }>>;
  /** Per company: the open deals' amounts summed per currency, as decimal strings. Companies without one have no entry. */
  openAmounts(organizationId: string, companyIds: readonly string[]): Promise<Map<string, Array<{ currency: string; amountMinor: string }>>>;
  /** Ids of the contacts that match the filter in the list's default order, at most `limit`, and how many match in all. */
  contactIds(organizationId: string, query: ContactFilter & { q?: string }, limit: number): Promise<{ ids: string[]; total: number }>;
  /** The person custom fields in Settings order, archived ones left out: the last columns of the Contacts CSV. */
  contactExportColumns(organizationId: string): Promise<Array<{ key: string; name: string }>>;
  /** The Contacts CSV rows in batches of 1,000, newest conversion first. `timeZone` is a valid IANA name. */
  contactsForExport(organizationId: string, scope: ContactExportScope, timeZone: string): AsyncGenerator<ContactExportRow[]>;
}

export interface DealsDeps {
  uow: UnitOfWork;
  store: DealStore;
  convertLead: ConvertLead;
  people: DealPeople;
  outreach: DealOutreach;
  events: DealEvents;
  members: DealMembers;
  crm: CrmRead;
  now: () => Date;
}

/** `addContactWithDeal`: the deals ports plus Add contact. The composition root wires both to leads. */
export interface AddContactWithDealDeps extends DealsDeps {
  createContact: CreateContact;
  dealTitleParts: DealTitleParts;
}
