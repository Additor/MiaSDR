import { MAX_MATCHING_IDS } from "@/contexts/people/domain/lead-filter";
import { csvLine, UTF8_BOM } from "@/shared/csv";
import { canonicalProfileUrl } from "@/contexts/people/domain/linkedin-url";
import { canonicalTimeZone } from "@/shared/time-zone";
import { NotFoundError, ValidationError, type Actor } from "@/shared/errors";
import { primaryDeal } from "../domain/primary-deal";
import { DEFAULT_DEAL_STAGES, type DealStageKind } from "../domain/stages";
import type { BoardCardRow, CompanySort, ContactLatestDealRow, ContactExportScope, ContactFilter, ContactListRow, ContactSort, DealPerson, DealsDeps, DealStage, PersonDealRow } from "./deal-ports";
import { BOARD_LIMIT, MAX_BOARD_LIMIT, CLOSED_WINDOW_DAYS, CRM_PAGE_SIZE, isUuid } from "./deal-input";

export interface DealOwner {
  userId: string;
  /** Null when the owner left the organization: the screens say "Former member". */
  name: string | null;
  isMember: boolean;
}

export interface DealSource {
  enrollmentId: string;
  campaignId: string;
  campaignName: string;
}

export interface DealView {
  id: string;
  title: string;
  version: number;
  stage: DealStage;
  owner: DealOwner | null;
  amountMinor: number | null;
  currency: string | null;
  expectedCloseOn: string | null;
  closedAt: Date | null;
  lostReason: string | null;
  stageChangedAt: Date;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
  /** "From {campaign}": the replied enrollment that converted the person, shown only for a regular campaign. */
  source: DealSource | null;
  person: DealPerson;
}

const ownerOf = (userId: string | null, names: Map<string, string>): DealOwner | null =>
  userId ? { userId, name: names.get(userId) ?? null, isMember: names.has(userId) } : null;

async function sourcesOf(deps: DealsDeps, organizationId: string, enrollmentIds: Array<string | null>): Promise<Map<string, DealSource>> {
  const ids = [...new Set(enrollmentIds.filter((id): id is string => Boolean(id)))];
  const out = new Map<string, DealSource>();
  if (ids.length === 0) return out;
  for (const [enrollmentId, source] of await deps.outreach.enrollmentSources(organizationId, ids)) {
    // A personal campaign is its creator's private outreach: the deal never names it.
    if (source.type === "regular") out.set(enrollmentId, { enrollmentId, campaignId: source.campaignId, campaignName: source.name });
  }
  return out;
}

export async function getDeal(deps: DealsDeps, actor: Actor, dealId: string): Promise<DealView> {
  if (!isUuid(dealId)) throw new NotFoundError("Deal not found");
  const row = await deps.crm.deal(actor.organizationId, dealId);
  if (!row) throw new NotFoundError("Deal not found");
  const [names, sources, people] = await Promise.all([
    deps.members.names(actor.organizationId),
    sourcesOf(deps, actor.organizationId, [row.sourceEnrollmentId]),
    deps.people.summaries(actor.organizationId, [row.personId]),
  ]);
  const person = people.get(row.personId);
  if (!person) throw new NotFoundError("Deal not found");
  return {
    id: row.id,
    title: row.title,
    version: row.version,
    stage: { id: row.stageId, name: row.stageName, kind: row.stageKind, position: row.stagePosition },
    owner: ownerOf(row.ownerUserId, names),
    amountMinor: row.amountMinor,
    currency: row.currency,
    expectedCloseOn: row.expectedCloseOn,
    closedAt: row.closedAt,
    lostReason: row.lostReason,
    stageChangedAt: row.stageChangedAt,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    source: row.sourceEnrollmentId ? (sources.get(row.sourceEnrollmentId) ?? null) : null,
    person,
  };
}

export interface BoardCard extends Omit<BoardCardRow, "ownerUserId" | "sourceEnrollmentId"> {
  owner: DealOwner | null;
  source: DealSource | null;
}

export interface BoardColumn {
  /** Null for a default stage of an organization that has no stages yet (`virtual`). */
  id: string | null;
  name: string;
  kind: DealStageKind;
  position: number;
  total: number;
  /** Decimal strings, exact above 2^53 - 1 (`BoardColumnRow`). */
  amounts: Array<{ currency: string; amountMinor: string }>;
  cards: BoardCard[];
  nextCursor: string | null;
}

export interface Board {
  /** True when the organization has no stages yet: the columns are the defaults and nothing was written. */
  virtual: boolean;
  showAll: boolean;
  /** Won and Lost columns hold deals closed at or after this instant; null with `showAll`. */
  closedSince: Date | null;
  columns: BoardColumn[];
}

export interface BoardInput {
  /** One stage only, for "N more" inside a column. */
  stage?: string | null;
  /** A user id, "me", or "none" for deals without an owner. */
  owner?: string | null;
  q?: string | null;
  limit?: number | null;
  /** From a column's `nextCursor`; needs `stage`. */
  cursor?: string | null;
  showAll?: boolean;
}

/** The Pipeline board: one column per stage in position order, newest stage move first, with totals per column. */
export async function board(deps: DealsDeps, actor: Actor, input: BoardInput = {}): Promise<Board> {
  const showAll = Boolean(input.showAll);
  const now = deps.now();
  const closedSince = showAll ? null : new Date(now.getTime() - CLOSED_WINDOW_DAYS * 86_400_000);
  const stages = await deps.store.listStages(actor.organizationId);
  if (stages.length === 0) {
    return {
      virtual: true,
      showAll,
      closedSince,
      columns: DEFAULT_DEAL_STAGES.map((s) => ({ id: null, ...s, total: 0, amounts: [], cards: [], nextCursor: null })),
    };
  }
  let selected = stages;
  if (input.stage) {
    selected = stages.filter((s) => s.id === input.stage);
    if (selected.length === 0) throw new ValidationError("Pick a stage of this pipeline.");
  }
  if (input.cursor && !input.stage) throw new ValidationError("A cursor needs its stage.");
  const owner = input.owner === "me" ? actor.userId : input.owner || undefined;
  if (owner !== undefined && owner !== "none" && !isUuid(owner)) throw new ValidationError("Filter by a member, me or none.");
  const limit = input.limit ?? BOARD_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_BOARD_LIMIT) throw new ValidationError(`Ask for 1 to ${MAX_BOARD_LIMIT} deals per stage.`);

  const rows = await deps.crm.board(actor.organizationId, {
    stageIds: selected.map((s) => s.id),
    owner,
    q: input.q?.trim() || undefined,
    limit,
    cursor: input.cursor ?? undefined,
    closedSince,
  });
  const byStage = new Map(rows.map((r) => [r.stageId, r]));
  const cards = rows.flatMap((r) => r.cards);
  const [names, sources] = await Promise.all([deps.members.names(actor.organizationId), sourcesOf(deps, actor.organizationId, cards.map((c) => c.sourceEnrollmentId))]);
  return {
    virtual: false,
    showAll,
    closedSince,
    columns: selected.map((stage) => {
      const row = byStage.get(stage.id);
      return {
        ...stage,
        total: row?.total ?? 0,
        amounts: row?.amounts ?? [],
        nextCursor: row?.nextCursor ?? null,
        cards: (row?.cards ?? []).map(({ ownerUserId, sourceEnrollmentId, ...card }) => ({
          ...card,
          owner: ownerOf(ownerUserId, names),
          source: sourceEnrollmentId ? (sources.get(sourceEnrollmentId) ?? null) : null,
        })),
      };
    }),
  };
}

export interface PersonDealSummary {
  deals: PersonDealRow[];
  openDeals: number;
  /** The person's primary deal (`primaryDeal`: open first, then the newest), for "Open deal". */
  latestDealId: string | null;
}

/** The deals of each person, for the contact page and the person card of the Inbox thread. Every requested id has an entry. */
export async function dealSummaryForPeople(deps: DealsDeps, actor: Actor, personIds: readonly string[]): Promise<Map<string, PersonDealSummary>> {
  const ids = [...new Set(personIds.filter(isUuid))];
  const out = new Map<string, PersonDealSummary>(ids.map((id) => [id, { deals: [], openDeals: 0, latestDealId: null }]));
  if (ids.length === 0) return out;
  for (const row of await deps.crm.dealsOfPeople(actor.organizationId, ids)) {
    const entry = out.get(row.personId);
    if (!entry) continue;
    entry.deals.push(row);
    if (row.stageKind === "open") entry.openDeals += 1;
  }
  for (const entry of out.values()) {
    entry.latestDealId = primaryDeal(entry.deals)?.id ?? null;
  }
  return out;
}

const pageOf = (page: number | null | undefined) => {
  const value = page ?? 1;
  if (!Number.isInteger(value) || value < 1) throw new ValidationError("Pages start at 1.");
  return value;
};

const CONTACT_SORTS: readonly ContactSort[] = ["converted", "name", "activity"];
const COMPANY_SORTS: readonly CompanySort[] = ["name", "contacts", "open_deals"];

export interface ContactListItem extends Omit<ContactListRow, "latestDeal"> {
  latestDeal: (Omit<ContactLatestDealRow, "ownerUserId"> & { owner: DealOwner | null }) | null;
}

export interface ContactListInput {
  q?: string | null;
  page?: number | null;
  sort?: string | null;
  /** The latest deal's owner: a user id, "me", or "none". */
  owner?: string | null;
  /** The latest deal's stage id. An id of no stage of the organization lists nothing. */
  stage?: string | null;
}

/**
 * The Contacts list: 25 per page, newest conversion first unless sorted by name or last activity. Each contact carries its
 * latest deal (the most recent open one, else the most recent) with the owner's name, and the owner and stage filters read
 * that deal.
 */
/** The search and the latest-deal filters of the Contacts list, checked. "me" becomes the actor. */
function contactFilter(actor: Actor, input: Pick<ContactListInput, "q" | "owner" | "stage">): ContactFilter & { q?: string } {
  const owner = input.owner === "me" ? actor.userId : input.owner || undefined;
  if (owner !== undefined && owner !== "none" && !isUuid(owner)) throw new ValidationError("Filter by a member, me or none.");
  const stageId = input.stage || undefined;
  if (stageId !== undefined && !isUuid(stageId)) throw new ValidationError("Pick a stage of this pipeline.");
  return { q: input.q?.trim() || undefined, owner, stageId };
}

export async function listContacts(deps: DealsDeps, actor: Actor, input: ContactListInput = {}): Promise<{ rows: ContactListItem[]; total: number; page: number; pageSize: number }> {
  const sort = (input.sort ?? "converted") as ContactSort;
  if (!CONTACT_SORTS.includes(sort)) throw new ValidationError("Sort contacts by converted, name or activity.");
  const page = pageOf(input.page);
  const filter = contactFilter(actor, input);
  const [{ rows, total }, names] = await Promise.all([
    deps.crm.contacts(actor.organizationId, { ...filter, sort, page, pageSize: CRM_PAGE_SIZE }),
    deps.members.names(actor.organizationId),
  ]);
  const items = rows.map(({ latestDeal, ...row }): ContactListItem => {
    if (!latestDeal) return { ...row, latestDeal: null };
    const { ownerUserId, ...deal } = latestDeal;
    return { ...row, latestDeal: { ...deal, owner: ownerOf(ownerUserId, names) } };
  });
  return { rows: items, total, page, pageSize: CRM_PAGE_SIZE };
}

/**
 * "Select all matching" on Contacts: the ids of the contacts that match the list's search and filters, newest conversion
 * first, up to 5,000 (`MAX_MATCHING_IDS`). `capped` is true when more match.
 */
export async function listContactIds(deps: DealsDeps, actor: Actor, input: Pick<ContactListInput, "q" | "owner" | "stage"> = {}): Promise<{ ids: string[]; total: number; capped: boolean }> {
  const { ids, total } = await deps.crm.contactIds(actor.organizationId, contactFilter(actor, input), MAX_MATCHING_IDS);
  return { ids, total, capped: total > MAX_MATCHING_IDS };
}

export const CONTACT_EXPORT_HEADER = [
  "Name",
  "Email",
  "Phone",
  "LinkedIn",
  "Job title",
  "Company",
  "Company domain",
  "Deal owner",
  "Latest deal",
  "Stage",
  "Open deals",
  "Contact since",
  "Last activity",
] as const;

/**
 * The Contacts CSV as text chunks: BOM and header first, then one chunk per batch of 1,000 rows. The scope is the list filter
 * or up to 5,000 ticked ids (Export selected); ids of leads or of another organization export nothing. Dates are ISO dates in
 * `timeZone`, the organization's zone (UTC when it is not a known zone). The person custom fields follow in Settings order.
 */
export async function* exportContactsCsv(
  deps: DealsDeps,
  actor: Actor,
  scope: { filter: Pick<ContactListInput, "q" | "owner" | "stage"> } | { ids: readonly string[] },
  timeZone: string | null | undefined,
): AsyncGenerator<string> {
  const organizationId = actor.organizationId;
  if ("ids" in scope && scope.ids.length > MAX_MATCHING_IDS) throw new ValidationError(`Export up to ${MAX_MATCHING_IDS} contacts at a time.`);
  const resolved: ContactExportScope = "ids" in scope ? { ids: [...new Set(scope.ids.filter(isUuid))] } : { filter: contactFilter(actor, scope.filter) };
  const zone = canonicalTimeZone(timeZone) ?? "UTC";
  const [columns, names] = await Promise.all([deps.crm.contactExportColumns(organizationId), deps.members.names(organizationId)]);
  yield UTF8_BOM + csvLine([...CONTACT_EXPORT_HEADER, ...columns.map((c) => c.name)]);
  if ("ids" in resolved && resolved.ids.length === 0) return;
  for await (const batch of deps.crm.contactsForExport(organizationId, resolved, zone)) {
    yield batch
      .map((row) =>
        csvLine([
          row.name,
          row.email,
          row.phone,
          row.linkedinUrl ?? (row.linkedinSlug ? canonicalProfileUrl(row.linkedinSlug) : null),
          row.title,
          row.companyName,
          row.companyDomain,
          row.ownerUserId ? (names.get(row.ownerUserId) ?? "Former member") : null,
          row.latestDealTitle,
          row.latestStageName,
          row.openDeals,
          row.contactSince,
          row.lastActivityOn,
          ...columns.map((c) => row.custom[c.key] ?? null),
        ]),
      )
      .join("");
  }
}

/**
 * The Companies list: a company listed in Companies (`crm_listed_at`, from Add company, a merge, or losing its last
 * contact) or with a contact today, with its contact and open-deal counts, last activity and open amounts. A company with
 * only leads from an import stays off.
 */
export async function listCompanies(deps: DealsDeps, actor: Actor, input: { q?: string | null; page?: number | null; sort?: string | null } = {}) {
  const sort = (input.sort ?? "name") as CompanySort;
  if (!COMPANY_SORTS.includes(sort)) throw new ValidationError("Sort companies by name, contacts or open_deals.");
  const page = pageOf(input.page);
  const { rows, total } = await deps.crm.companies(actor.organizationId, { q: input.q?.trim() || undefined, sort, page, pageSize: CRM_PAGE_SIZE });
  return { rows, total, page, pageSize: CRM_PAGE_SIZE };
}

/**
 * A company with its contacts, their deals and the header counts: contacts, open deals and the open amount per currency,
 * by the rules of the Companies list. Any company of the organization answers. `updateCompany` in the people context edits it.
 */
export async function getCompany(deps: DealsDeps, actor: Actor, companyId: string) {
  if (!isUuid(companyId)) throw new NotFoundError("Company not found");
  const company = await deps.crm.company(actor.organizationId, companyId);
  if (!company) throw new NotFoundError("Company not found");
  const org = actor.organizationId;
  const [contacts, deals, summaries, amounts] = await Promise.all([
    deps.crm.contactsOfCompany(org, companyId),
    deps.crm.dealsOfCompany(org, companyId),
    deps.crm.companySummaries(org, [companyId]),
    deps.crm.openAmounts(org, [companyId]),
  ]);
  const counts = summaries.get(companyId) ?? { contacts: 0, openDeals: 0 };
  return { company, contacts, deals, summary: { ...counts, openAmounts: amounts.get(companyId) ?? [] } };
}
