import { sql, type SQL } from "drizzle-orm";
import { db } from "@/platform/db/client";
import { ValidationError } from "@/shared/errors";
import { publicConversationText } from "@/platform/db/conversation-visibility";
import type { DealStageKind } from "../domain/stages";
import type {
  BoardCardRow,
  BoardColumnRow,
  BoardQuery,
  CompanyDetailRow,
  CompanyListRow,
  CompanySort,
  ContactExportRow,
  ContactExportScope,
  ContactFilter,
  ContactListRow,
  ContactSort,
  CrmRead,
  DealViewRow,
  PersonDealRow,
} from "../application/deal-ports";
import { rowsOf } from "@/platform/db/sql-values";

/*
 * crm-read: the explicit read model of the CRM screens ("Leads and CRM" in docs/decisions.md), like analytics.
 *
 * Tables it reads, and only these:
 *   people         p   (the contact, its lifecycle and conversion time, its LinkedIn values for the reach icons, phone and custom values for the CSV)
 *   companies      c   (the contact's employer, and when Companies lists it)
 *   company_domain_aliases cda (a company's other domains, for the company page)
 *   entity_columns ec  (the person custom fields, for the Contacts CSV)
 *   deals          d
 *   deal_stages    s
 *   events         e   (last activity of a contact, and of a company through its contacts)
 *   contact_policies cp (do not contact)
 *   conversations      (visibility only, through `publicConversationText`: an event of a record whose threads are all private is left out)
 *
 * It is read-only: no statement here writes, and writes never go through it. `crm-read.integration.test.ts` pins the columns
 * it reads, so a schema change that touches them shows up there. Every statement filters by organization. The Contacts list
 * writes `p.lifecycle = 'contact'` as a literal, so a generic plan can still use the partial index `people_org_contacts_idx`.
 */

const toDate = (value: unknown): Date => (value instanceof Date ? value : new Date(String(value)));
const toDateOrNull = (value: unknown): Date | null => (value === null || value === undefined ? null : toDate(value));
const toNumberOrNull = (value: unknown): number | null => (value === null || value === undefined ? null : Number(value));
const uuidList = (ids: readonly string[]) => sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `);

/** Escapes LIKE wildcards so a search for "50%" matches the text. */
const likePattern = (term: string) => `%${term.slice(0, 100).replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;

/** An event the screens may show: no record, or a record with a public thread or none (the rule of `visibleRecordText`). */
const visibleEvent = sql.raw(
  `(e.record_id is null or exists (select 1 from conversations vc where vc.record_id = e.record_id and ${publicConversationText("vc")}) or not exists (select 1 from conversations vc2 where vc2.record_id = e.record_id))`,
);

// ---- Board ---------------------------------------------------------------------------------------------------

interface CardSql {
  stage_id: string;
  id: string;
  title: string;
  person_id: string;
  person_name: string | null;
  company_name: string | null;
  amount_minor: string | number | null;
  currency: string | null;
  owner_user_id: string | null;
  expected_close_on: string | null;
  closed_at: unknown;
  stage_changed_at: unknown;
  cursor_at: string;
  source_enrollment_id: string | null;
  version: number;
}

export function encodeCursor(at: string, id: string): string {
  return Buffer.from(`${at}|${id}`, "utf8").toString("base64url");
}

const CURSOR_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/;
const CURSOR_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The position a cursor names, or null when it does not decode to an instant and a deal id. */
export function decodeCursor(cursor: string): { at: string; id: string } | null {
  const parts = Buffer.from(cursor, "base64url").toString("utf8").split("|");
  const [at, id] = parts;
  if (parts.length !== 2 || !CURSOR_AT.test(at) || Number.isNaN(Date.parse(at)) || !CURSOR_ID.test(id)) return null;
  return { at, id };
}

/** The filters every board statement shares. `s` is the deal's stage. */
function boardFilter(organizationId: string, query: BoardQuery): SQL {
  const parts: SQL[] = [sql`d.organization_id = ${organizationId}`];
  if (query.owner === "none") parts.push(sql`d.owner_user_id is null`);
  else if (query.owner) parts.push(sql`d.owner_user_id = ${query.owner}::uuid`);
  if (query.closedSince) parts.push(sql`(s.kind = 'open' or d.closed_at >= ${query.closedSince.toISOString()}::timestamptz)`);
  if (query.q) {
    const pattern = likePattern(query.q);
    parts.push(sql`(d.title ilike ${pattern} or p.full_name ilike ${pattern} or p.email ilike ${pattern} or c.name ilike ${pattern} or c.domain ilike ${pattern})`);
  }
  return sql.join(parts, sql` and `);
}

async function board(organizationId: string, query: BoardQuery): Promise<BoardColumnRow[]> {
  if (query.stageIds.length === 0) return [];
  const stages = uuidList(query.stageIds);
  const filter = boardFilter(organizationId, query);
  const from = sql`from deals d
    join deal_stages s on s.id = d.stage_id and s.organization_id = d.organization_id
    join people p on p.id = d.person_id and p.organization_id = d.organization_id
    left join companies c on c.id = p.company_id and c.organization_id = p.organization_id`;

  const totals = rowsOf<{ stage_id: string; currency: string | null; total: number; amount: string | null }>(
    await db.execute(sql`
      select d.stage_id, d.currency, count(*)::int as total, sum(d.amount_minor)::text as amount
      ${from}
      where ${filter} and d.stage_id in (${stages})
      group by d.stage_id, d.currency`),
  );

  const cursor = query.cursor ? decodeCursor(query.cursor) : null;
  // A cursor that does not decode would otherwise answer the first page again, and "N more" would repeat cards.
  if (query.cursor && !cursor) throw new ValidationError("This page of the board is out of date. Reload the board.");
  const after = cursor ? sql`and (d.stage_changed_at, d.id) < (${cursor.at}::timestamptz, ${cursor.id}::uuid)` : sql``;
  // One column at a time through the (organization_id, stage_id, stage_changed_at desc) index, newest move first.
  const cards = rowsOf<CardSql>(
    await db.execute(sql`
      select col.id as stage_id, card.*
      from deal_stages col
      cross join lateral (
        select d.id, d.title, d.person_id, coalesce(p.full_name, p.email) as person_name, c.name as company_name,
               d.amount_minor, d.currency, d.owner_user_id, to_char(d.expected_close_on, 'YYYY-MM-DD') as expected_close_on,
               d.closed_at, d.stage_changed_at, d.source_enrollment_id, d.version,
               to_char(d.stage_changed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as cursor_at
        ${from}
        where ${filter} and d.stage_id = col.id ${after}
        order by d.stage_changed_at desc, d.id desc
        limit ${query.limit + 1}
      ) card
      where col.organization_id = ${organizationId} and col.id in (${stages})`),
  );

  return query.stageIds.map((stageId) => {
    const own = totals.filter((t) => t.stage_id === stageId);
    const rows = cards.filter((card) => card.stage_id === stageId);
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return {
      stageId,
      total: own.reduce((sum, t) => sum + t.total, 0),
      amounts: own
        .filter((t) => t.currency !== null && t.amount !== null)
        .map((t) => ({ currency: t.currency as string, amountMinor: t.amount as string }))
        .sort((a, b) => a.currency.localeCompare(b.currency)),
      cards: page.map(toCard),
      nextCursor: rows.length > query.limit && last ? encodeCursor(last.cursor_at, last.id) : null,
    };
  });
}

function toCard(row: CardSql): BoardCardRow {
  return {
    id: row.id,
    title: row.title,
    personId: row.person_id,
    personName: row.person_name,
    companyName: row.company_name,
    amountMinor: toNumberOrNull(row.amount_minor),
    currency: row.currency,
    ownerUserId: row.owner_user_id,
    expectedCloseOn: row.expected_close_on,
    closedAt: toDateOrNull(row.closed_at),
    stageChangedAt: toDate(row.stage_changed_at),
    sourceEnrollmentId: row.source_enrollment_id,
    version: row.version,
  };
}

// ---- One deal, deals of people and companies -------------------------------------------------------------

async function deal(organizationId: string, dealId: string): Promise<DealViewRow | null> {
  const [row] = rowsOf<Record<string, unknown>>(
    await db.execute(sql`
      select d.id, d.person_id, d.stage_id, d.stage_kind, d.title, d.owner_user_id, d.amount_minor, d.currency,
             to_char(d.expected_close_on, 'YYYY-MM-DD') as expected_close_on, d.closed_at, d.lost_reason, d.stage_changed_at,
             d.source_enrollment_id, d.version, d.created_by, d.created_at, d.updated_at, s.name as stage_name, s.position as stage_position
      from deals d join deal_stages s on s.id = d.stage_id and s.organization_id = d.organization_id
      where d.organization_id = ${organizationId} and d.id = ${dealId}::uuid`),
  );
  if (!row) return null;
  return {
    id: row.id as string,
    personId: row.person_id as string,
    stageId: row.stage_id as string,
    stageKind: row.stage_kind as DealStageKind,
    title: row.title as string,
    ownerUserId: (row.owner_user_id as string | null) ?? null,
    amountMinor: toNumberOrNull(row.amount_minor),
    currency: (row.currency as string | null) ?? null,
    expectedCloseOn: (row.expected_close_on as string | null) ?? null,
    closedAt: toDateOrNull(row.closed_at),
    lostReason: (row.lost_reason as string | null) ?? null,
    stageChangedAt: toDate(row.stage_changed_at),
    sourceEnrollmentId: (row.source_enrollment_id as string | null) ?? null,
    version: row.version as number,
    createdBy: (row.created_by as string | null) ?? null,
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at),
    stageName: row.stage_name as string,
    stagePosition: row.stage_position as number,
  };
}

const personDealSelect = sql`
  select d.id, d.person_id, d.title, d.stage_id, s.name as stage_name, d.stage_kind, d.amount_minor, d.currency, d.closed_at, d.stage_changed_at, d.created_at
  from deals d join deal_stages s on s.id = d.stage_id and s.organization_id = d.organization_id`;

function toPersonDeal(row: Record<string, unknown>): PersonDealRow {
  return {
    id: row.id as string,
    personId: row.person_id as string,
    title: row.title as string,
    stageId: row.stage_id as string,
    stageName: row.stage_name as string,
    stageKind: row.stage_kind as DealStageKind,
    amountMinor: toNumberOrNull(row.amount_minor),
    currency: (row.currency as string | null) ?? null,
    closedAt: toDateOrNull(row.closed_at),
    stageChangedAt: toDate(row.stage_changed_at),
    createdAt: toDate(row.created_at),
  };
}

async function dealsOfPeople(organizationId: string, personIds: readonly string[]): Promise<PersonDealRow[]> {
  if (personIds.length === 0) return [];
  const rows = rowsOf<Record<string, unknown>>(
    await db.execute(sql`${personDealSelect} where d.organization_id = ${organizationId} and d.person_id in (${uuidList(personIds)}) order by d.created_at desc, d.id desc`),
  );
  return rows.map(toPersonDeal);
}

async function dealsOfCompany(organizationId: string, companyId: string): Promise<PersonDealRow[]> {
  const rows = rowsOf<Record<string, unknown>>(
    await db.execute(sql`
      ${personDealSelect}
      join people p on p.id = d.person_id and p.organization_id = d.organization_id
      where d.organization_id = ${organizationId} and p.company_id = ${companyId}::uuid
      order by d.created_at desc, d.id desc
      limit 500`),
  );
  return rows.map(toPersonDeal);
}

// ---- Contacts ------------------------------------------------------------------------------------------------

/** The person's primary deal, in the order of `primaryDeal` (deals/domain/primary-deal.ts): open first, newest, higher id. */
const latestDealJoin = sql`
  left join lateral (
    select d.id, d.title, d.stage_id, s.name as stage_name, d.stage_kind, d.owner_user_id
    from deals d join deal_stages s on s.id = d.stage_id and s.organization_id = d.organization_id
    where d.organization_id = p.organization_id and d.person_id = p.id
    order by (d.stage_kind = 'open') desc, d.created_at desc, d.id desc
    limit 1
  ) ld on true`;

const contactFrom = sql`
  from people p
  left join companies c on c.id = p.company_id and c.organization_id = p.organization_id
  left join contact_policies cp on cp.person_id = p.id and cp.organization_id = p.organization_id
  ${latestDealJoin}`;

const contactSelect = sql`
  select p.id, coalesce(p.full_name, p.email) as name, p.email, p.linkedin_slug, p.linkedin_url, p.title, p.company_id, c.name as company_name, p.converted_at,
         coalesce(cp.do_not_contact, false) as do_not_contact,
         ld.id as latest_deal_id, ld.stage_id as latest_stage_id, ld.stage_name as latest_stage_name, ld.stage_kind as latest_stage_kind,
         ld.owner_user_id as latest_owner_user_id,
         (select count(*)::int from deals d where d.organization_id = p.organization_id and d.person_id = p.id and d.stage_kind = 'open') as open_deals,
         (select max(e.created_at) from events e where e.organization_id = p.organization_id and e.person_id = p.id and ${visibleEvent}) as last_activity_at
  ${contactFrom}`;

function toContact(row: Record<string, unknown>): ContactListRow {
  return {
    id: row.id as string,
    name: (row.name as string | null) ?? null,
    email: (row.email as string | null) ?? null,
    linkedinSlug: (row.linkedin_slug as string | null) ?? null,
    linkedinUrl: (row.linkedin_url as string | null) ?? null,
    title: (row.title as string | null) ?? null,
    companyId: (row.company_id as string | null) ?? null,
    companyName: (row.company_name as string | null) ?? null,
    convertedAt: toDate(row.converted_at),
    openDeals: row.open_deals as number,
    lastActivityAt: toDateOrNull(row.last_activity_at),
    doNotContact: Boolean(row.do_not_contact),
    latestDeal: row.latest_deal_id
      ? {
          id: row.latest_deal_id as string,
          stageId: row.latest_stage_id as string,
          stageName: row.latest_stage_name as string,
          stageKind: row.latest_stage_kind as DealStageKind,
          ownerUserId: (row.latest_owner_user_id as string | null) ?? null,
        }
      : null,
  };
}

const CONTACT_ORDER: Record<ContactSort, SQL> = {
  // Newest conversion first, on the partial index (organization_id, converted_at desc, id).
  converted: sql`order by p.converted_at desc, p.id`,
  name: sql`order by lower(coalesce(p.full_name, p.email)) nulls last, p.id`,
  activity: sql`order by last_activity_at desc nulls last, p.converted_at desc, p.id`,
};

/** Search and filters. The owner and stage filters read the latest deal, the one the list shows. */
function contactWhere(query: ContactFilter & { q?: string }): SQL {
  const parts: SQL[] = [];
  if (query.q) {
    const pattern = likePattern(query.q);
    parts.push(sql`and (p.full_name ilike ${pattern} or p.email ilike ${pattern} or p.title ilike ${pattern} or c.name ilike ${pattern} or c.domain ilike ${pattern})`);
  }
  if (query.owner === "none") parts.push(sql`and ld.id is not null and ld.owner_user_id is null`);
  else if (query.owner) parts.push(sql`and ld.owner_user_id = ${query.owner}::uuid`);
  if (query.stageId) parts.push(sql`and ld.stage_id = ${query.stageId}::uuid`);
  return sql.join(parts, sql` `);
}

async function contacts(organizationId: string, query: ContactFilter & { q?: string; sort: ContactSort; page: number; pageSize: number }) {
  const where = contactWhere(query);
  const rows = rowsOf<Record<string, unknown>>(
    await db.execute(sql`
      ${contactSelect}
      where p.organization_id = ${organizationId} and p.lifecycle = 'contact' ${where}
      ${CONTACT_ORDER[query.sort]}
      limit ${query.pageSize} offset ${(query.page - 1) * query.pageSize}`),
  );
  // The count joins the latest deal only when a filter reads it.
  const countFrom = query.owner || query.stageId ? contactFrom : sql`from people p left join companies c on c.id = p.company_id and c.organization_id = p.organization_id`;
  const [count] = rowsOf<{ total: number }>(
    await db.execute(sql`
      select count(*)::int as total ${countFrom}
      where p.organization_id = ${organizationId} and p.lifecycle = 'contact' ${where}`),
  );
  return { rows: rows.map(toContact), total: count?.total ?? 0 };
}

/** Ids of the contacts that match, newest conversion first (the list's default order), at most `limit`, with the full count. */
async function contactIds(organizationId: string, query: ContactFilter & { q?: string }, limit: number) {
  const where = contactWhere(query);
  const from = query.owner || query.stageId ? contactFrom : sql`from people p left join companies c on c.id = p.company_id and c.organization_id = p.organization_id`;
  const rows = rowsOf<{ id: string; total: number }>(
    await db.execute(sql`
      select p.id, count(*) over ()::int as total ${from}
      where p.organization_id = ${organizationId} and p.lifecycle = 'contact' ${where}
      order by p.converted_at desc, p.id
      limit ${limit}`),
  );
  if (rows.length > 0) return { ids: rows.map((row) => row.id), total: rows[0].total };
  return { ids: [], total: 0 };
}

async function contactExportColumns(organizationId: string) {
  return rowsOf<{ key: string; name: string }>(
    await db.execute(sql`
      select ec.key, ec.name from entity_columns ec
      where ec.organization_id = ${organizationId} and ec.entity = 'people' and ec.archived_at is null
      order by ec.position, ec.name`),
  );
}

const EXPORT_BATCH = 1000;

/** Keyset pages on (converted_at, id), newest first. The cursor keeps converted_at as text, because a JS Date drops microseconds. */
async function* contactsForExport(organizationId: string, scope: ContactExportScope, timeZone: string): AsyncGenerator<ContactExportRow[]> {
  const scoped = "ids" in scope ? (scope.ids.length > 0 ? sql`and p.id in (${uuidList(scope.ids)})` : sql`and false`) : contactWhere(scope.filter);
  let cursor: { at: string; id: string } | null = null;
  for (;;) {
    const after: SQL = cursor ? sql`and (p.converted_at, p.id) < (${cursor.at}::timestamptz, ${cursor.id}::uuid)` : sql``;
    const rows = rowsOf<Record<string, unknown>>(
      await db.execute(sql`
        select p.id, coalesce(p.full_name, p.email) as name, p.email, p.phone, p.linkedin_slug, p.linkedin_url, p.title, p.custom,
               c.name as company_name, c.domain as company_domain,
               ld.owner_user_id as latest_owner_user_id, ld.title as latest_title, ld.stage_name as latest_stage_name,
               (select count(*)::int from deals d where d.organization_id = p.organization_id and d.person_id = p.id and d.stage_kind = 'open') as open_deals,
               p.converted_at::text as converted_at_text,
               to_char(p.converted_at at time zone ${timeZone}, 'YYYY-MM-DD') as contact_since,
               to_char((select max(e.created_at) from events e where e.organization_id = p.organization_id and e.person_id = p.id and ${visibleEvent}) at time zone ${timeZone}, 'YYYY-MM-DD') as last_activity_on
        ${contactFrom}
        where p.organization_id = ${organizationId} and p.lifecycle = 'contact' ${scoped} ${after}
        order by p.converted_at desc, p.id desc
        limit ${EXPORT_BATCH}`),
    );
    if (rows.length === 0) return;
    yield rows.map(
      (row): ContactExportRow => ({
        id: row.id as string,
        name: (row.name as string | null) ?? null,
        email: (row.email as string | null) ?? null,
        phone: (row.phone as string | null) ?? null,
        linkedinSlug: (row.linkedin_slug as string | null) ?? null,
        linkedinUrl: (row.linkedin_url as string | null) ?? null,
        title: (row.title as string | null) ?? null,
        companyName: (row.company_name as string | null) ?? null,
        companyDomain: (row.company_domain as string | null) ?? null,
        ownerUserId: (row.latest_owner_user_id as string | null) ?? null,
        latestDealTitle: (row.latest_title as string | null) ?? null,
        latestStageName: (row.latest_stage_name as string | null) ?? null,
        openDeals: row.open_deals as number,
        contactSince: row.contact_since as string,
        lastActivityOn: (row.last_activity_on as string | null) ?? null,
        custom: (row.custom as Record<string, unknown> | null) ?? {},
      }),
    );
    if (rows.length < EXPORT_BATCH) return;
    const last = rows[rows.length - 1];
    cursor = { at: last.converted_at_text as string, id: last.id as string };
  }
}

async function contactsOfCompany(organizationId: string, companyId: string): Promise<ContactListRow[]> {
  const rows = rowsOf<Record<string, unknown>>(
    await db.execute(sql`
      ${contactSelect}
      where p.organization_id = ${organizationId} and p.lifecycle = 'contact' and p.company_id = ${companyId}::uuid
      order by p.converted_at desc, p.id
      limit 500`),
  );
  return rows.map(toContact);
}

// ---- Companies -----------------------------------------------------------------------------------------------

/** Contacts and open deals per company of the organization; a company with no contact has no `contact_counts` row. */
const companyCounts = (organizationId: string) => sql`
  with contact_counts as (
    select p.company_id, count(*)::int as contacts
    from people p
    where p.organization_id = ${organizationId} and p.lifecycle = 'contact' and p.company_id is not null
    group by p.company_id
  ), open_counts as (
    select p.company_id, count(*)::int as open_deals
    from deals d join people p on p.id = d.person_id and p.organization_id = d.organization_id
    where d.organization_id = ${organizationId} and d.stage_kind = 'open' and p.company_id is not null
    group by p.company_id
  )`;

/** The latest visible event of the company's contacts, the Contacts list's last activity taken over all of them. */
const companyActivity = sql`(
  select max(e.created_at)
  from people p join events e on e.organization_id = p.organization_id and e.person_id = p.id
  where p.organization_id = c.organization_id and p.company_id = c.id and p.lifecycle = 'contact' and ${visibleEvent})`;

/**
 * Sum per currency of the open deals of each company. The sum leaves Postgres as text: amounts that each fit 2^53 - 1 can add
 * up past it, as on the board.
 */
async function openAmounts(organizationId: string, companyIds: readonly string[]) {
  const out = new Map<string, Array<{ currency: string; amountMinor: string }>>();
  if (companyIds.length === 0) return out;
  const rows = rowsOf<{ company_id: string; currency: string; amount: string }>(
    await db.execute(sql`
      select p.company_id, d.currency, sum(d.amount_minor)::text as amount
      from deals d join people p on p.id = d.person_id and p.organization_id = d.organization_id
      where d.organization_id = ${organizationId} and d.stage_kind = 'open' and d.amount_minor is not null and d.currency is not null
        and p.company_id in (${uuidList(companyIds)})
      group by p.company_id, d.currency
      order by d.currency`),
  );
  for (const row of rows) {
    const list = out.get(row.company_id) ?? [];
    list.push({ currency: row.currency, amountMinor: row.amount });
    out.set(row.company_id, list);
  }
  return out;
}

const COMPANY_ORDER: Record<CompanySort, SQL> = {
  name: sql`order by lower(coalesce(c.name, c.domain)), c.id`,
  contacts: sql`order by contacts desc, lower(coalesce(c.name, c.domain)), c.id`,
  open_deals: sql`order by open_deals desc, lower(coalesce(c.name, c.domain)), c.id`,
};

async function companies(organizationId: string, query: { q?: string; sort: CompanySort; page: number; pageSize: number }) {
  const pattern = query.q ? likePattern(query.q) : null;
  const search = pattern ? sql`and (c.name ilike ${pattern} or c.domain ilike ${pattern})` : sql``;
  // M3: listed once stamped (Add company, a merge, losing its last contact) or while it has a contact. Leads-only companies stay off.
  const base = sql`
    from companies c
    left join contact_counts cc on cc.company_id = c.id
    left join open_counts oc on oc.company_id = c.id
    where c.organization_id = ${organizationId} ${search}
      and (c.crm_listed_at is not null or exists (select 1 from people p where p.organization_id = c.organization_id and p.company_id = c.id and p.lifecycle = 'contact'))`;
  const rows = rowsOf<Record<string, unknown>>(
    await db.execute(sql`
      ${companyCounts(organizationId)}
      select c.id, c.name, c.domain, c.linkedin_url, coalesce(cc.contacts, 0)::int as contacts, coalesce(oc.open_deals, 0)::int as open_deals, ${companyActivity} as last_activity_at
      ${base}
      ${COMPANY_ORDER[query.sort]}
      limit ${query.pageSize} offset ${(query.page - 1) * query.pageSize}`),
  );
  const [count] = rowsOf<{ total: number }>(await db.execute(sql`${companyCounts(organizationId)} select count(*)::int as total ${base}`));
  const amounts = await openAmounts(organizationId, rows.map((row) => row.id as string));
  return {
    rows: rows.map(
      (row): CompanyListRow => ({
        id: row.id as string,
        name: (row.name as string | null) ?? null,
        domain: row.domain as string,
        linkedinUrl: (row.linkedin_url as string | null) ?? null,
        contacts: row.contacts as number,
        openDeals: row.open_deals as number,
        lastActivityAt: toDateOrNull(row.last_activity_at),
        openAmounts: amounts.get(row.id as string) ?? [],
      }),
    ),
    total: count?.total ?? 0,
  };
}

/** Any company of the organization, listed or not, with its version, other domains and people counts. */
async function company(organizationId: string, companyId: string): Promise<CompanyDetailRow | null> {
  const [row] = rowsOf<Record<string, unknown>>(
    await db.execute(sql`
      select c.id, c.name, c.domain, c.linkedin_url, c.custom, c.created_at, c.version, c.crm_listed_at,
             (select count(*)::int from people p where p.organization_id = c.organization_id and p.company_id = c.id and p.lifecycle = 'contact') as contacts,
             (select count(*)::int from people p where p.organization_id = c.organization_id and p.company_id = c.id and p.lifecycle = 'lead') as leads
      from companies c where c.organization_id = ${organizationId} and c.id = ${companyId}::uuid`),
  );
  if (!row) return null;
  const aliases = rowsOf<{ domain: string; merged_name: string | null }>(
    await db.execute(sql`
      select cda.domain, cda.merged_name from company_domain_aliases cda
      where cda.organization_id = ${organizationId} and cda.company_id = ${companyId}::uuid
      order by cda.created_at, cda.domain`),
  );
  return {
    id: row.id as string,
    name: (row.name as string | null) ?? null,
    domain: row.domain as string,
    linkedinUrl: (row.linkedin_url as string | null) ?? null,
    custom: (row.custom as Record<string, unknown> | null) ?? {},
    createdAt: toDate(row.created_at),
    version: row.version as number,
    crmListedAt: toDateOrNull(row.crm_listed_at),
    aliases: aliases.map((alias) => ({ domain: alias.domain, mergedName: alias.merged_name ?? null })),
    contacts: row.contacts as number,
    leads: row.leads as number,
  };
}

async function companySummaries(organizationId: string, companyIds: readonly string[]) {
  const out = new Map<string, { contacts: number; openDeals: number }>();
  if (companyIds.length === 0) return out;
  const rows = rowsOf<{ id: string; contacts: number; open_deals: number }>(
    await db.execute(sql`
      ${companyCounts(organizationId)}
      select c.id, cc.contacts, coalesce(oc.open_deals, 0)::int as open_deals
      from companies c
      join contact_counts cc on cc.company_id = c.id
      left join open_counts oc on oc.company_id = c.id
      where c.organization_id = ${organizationId} and c.id in (${uuidList(companyIds)})`),
  );
  for (const row of rows) out.set(row.id, { contacts: row.contacts, openDeals: row.open_deals });
  return out;
}

export const crmRead: CrmRead = {
  board,
  deal,
  dealsOfPeople,
  dealsOfCompany,
  contacts,
  companies,
  company,
  contactsOfCompany,
  companySummaries,
  openAmounts,
  contactIds,
  contactExportColumns,
  contactsForExport,
};
