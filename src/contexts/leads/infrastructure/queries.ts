import { and, asc, count, eq, ilike, inArray, isNotNull, isNull, or, sql, type Column, type SQL } from "drizzle-orm";
import { db } from "@/platform/db/client";
import { campaignEnrollments, campaigns, companies, contactPolicies, conversations, messages, people, records } from "@/platform/db/schema";
import { publicConversation } from "@/platform/db/conversation-visibility";
import { DEFAULT_LEAD_SORT, lifecycleOf, type LeadFilter, type LeadSort } from "../domain/lead-filter";
import { normalizeLinkedinSlug } from "../domain/normalize";

export interface LeadRow {
  id: string;
  fullName: string | null;
  email: string | null;
  title: string | null;
  phone: string | null;
  linkedinSlug: string | null;
  /** Canonical profile URL, or another LinkedIn page kept as imported. The list builds the profile link from it. */
  linkedinUrl: string | null;
  companyName: string | null;
  companyDomain: string | null;
  createdAt: Date;
  updatedAt: Date;
  doNotContact: boolean;
  lifecycle: string;
  convertedAt: Date | null;
}

export const LEADS_PAGE_SIZE = 50;
export const LEADS_PAGE_SIZES = [25, 50, 100, 200] as const;

/** Falls back to the default for anything that is not an offered size. */
export function pickPageSize(value: number | undefined): number {
  return LEADS_PAGE_SIZES.find((size) => size === value) ?? LEADS_PAGE_SIZE;
}

/** Escapes LIKE wildcards so a search for "50%" matches the text, not everything. */
function likePattern(term: string): string {
  return `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/** A search term that reads as a phone number: digits with the usual separators. */
function phoneDigits(text: string): string | null {
  if (!/^\+?[\d\s().-]+$/.test(text)) return null;
  // Stored numbers are E.164, so a local leading zero never appears in them.
  const digits = text.replace(/\D/g, "").replace(/^0+/, "");
  return digits.length >= 3 ? digits : null;
}

/** Case-insensitive match on name, email, title, company, LinkedIn and phone. Shared by the lead list and campaign enrollment. */
export function leadSearchCondition(term: string | undefined): SQL | undefined {
  const text = term?.trim().slice(0, 100);
  if (!text) return undefined;
  const conditions: Array<SQL | undefined> = [
    ilike(people.fullName, likePattern(text)),
    ilike(people.email, likePattern(text)),
    ilike(people.title, likePattern(text)),
    ilike(companies.name, likePattern(text)),
    ilike(companies.domain, likePattern(text)),
    ilike(people.linkedinSlug, likePattern(text)),
    ilike(people.linkedinUrl, likePattern(text)),
  ];
  // A pasted profile URL matches the slug whatever its form (www, trailing slash, query string).
  const slug = /linkedin\.com/i.test(text) ? normalizeLinkedinSlug(text) : null;
  if (slug) conditions.push(eq(people.linkedinSlug, slug));
  const digits = phoneDigits(text);
  // The digits come from \d only, so they hold no LIKE wildcard.
  if (digits) conditions.push(sql`${people.phone} like ${`%${digits}%`}`);
  return or(...conditions);
}

/**
 * Membership in a campaign. "Any campaign" and "none" count regular campaigns only, like the list's Status column:
 * a personal campaign (`type = 'personal'`) is a private thread and never shows there. A named campaign matches its own id.
 */
const inCampaign = (campaignId: SQL | string | null) =>
  campaignId === null
    ? sql`exists (select 1 from ${campaignEnrollments} inner join ${campaigns} on ${campaigns.id} = ${campaignEnrollments.campaignId} and ${campaigns.organizationId} = ${campaignEnrollments.organizationId} where ${campaignEnrollments.personId} = ${people.id} and ${campaignEnrollments.organizationId} = ${people.organizationId} and ${campaignEnrollments.status} <> 'removed' and ${campaigns.type} = 'regular')`
    : sql`exists (select 1 from ${campaignEnrollments} where ${campaignEnrollments.personId} = ${people.id} and ${campaignEnrollments.organizationId} = ${people.organizationId} and ${campaignEnrollments.status} <> 'removed' and ${campaignEnrollments.campaignId} = ${campaignId}::uuid)`;

/**
 * The time of the lead's latest outreach that went out on any channel: the later of an outbound message (records,
 * conversations, messages) and a campaign step (`campaign_enrollments.last_sent_at`, regular campaigns only), as one aggregate. Personal (private) threads stay out. Null when nothing was sent. `readLeadStatuses` (outreach
 * context) takes the same maximum for a page of leads.
 */
const lastSentAt = sql`select max(t.at) as at from (
  select ${messages.sentAt} as at from ${records} inner join ${conversations} on ${conversations.recordId} = ${records.id} and ${conversations.organizationId} = ${records.organizationId} inner join ${messages} on ${messages.conversationId} = ${conversations.id} and ${messages.organizationId} = ${conversations.organizationId} where ${records.personId} = ${people.id} and ${records.organizationId} = ${people.organizationId} and ${publicConversation} and ${messages.direction} = 'outbound'
  union all
  select ${campaignEnrollments.lastSentAt} as at from ${campaignEnrollments} inner join ${campaigns} on ${campaigns.id} = ${campaignEnrollments.campaignId} and ${campaigns.organizationId} = ${campaignEnrollments.organizationId} where ${campaignEnrollments.personId} = ${people.id} and ${campaignEnrollments.organizationId} = ${people.organizationId} and ${campaigns.type} = 'regular'
) as t`;

/** An enrollment of the lead in a regular campaign has been stopped by a reply. */
const repliedEnrollment = sql`exists (select 1 from ${campaignEnrollments} inner join ${campaigns} on ${campaigns.id} = ${campaignEnrollments.campaignId} and ${campaigns.organizationId} = ${campaignEnrollments.organizationId} where ${campaignEnrollments.personId} = ${people.id} and ${campaignEnrollments.organizationId} = ${people.organizationId} and ${campaignEnrollments.status} = 'replied' and ${campaigns.type} = 'regular')`;

/** The person wrote at least one message in a public conversation (a personal campaign's private thread never counts). */
const inboundMessage = sql`exists (select 1 from ${records} inner join ${conversations} on ${conversations.recordId} = ${records.id} and ${conversations.organizationId} = ${records.organizationId} inner join ${messages} on ${messages.conversationId} = ${conversations.id} and ${messages.organizationId} = ${conversations.organizationId} where ${records.personId} = ${people.id} and ${records.organizationId} = ${people.organizationId} and ${publicConversation} and ${messages.direction} = 'inbound')`;

/**
 * Replied: an enrollment has status `replied`, or the person has an inbound message in a public conversation. The lead
 * status (`readLeadStatuses`, read by the lead list and the lead page) and this filter use the same definition, so an
 * unknown sender who wrote first shows Replied.
 */
const replied = sql`(${repliedEnrollment} or ${inboundMessage})`;

/** The person has a record with a public conversation, inbound or outbound. */
const hasPublicConversation = sql`exists (select 1 from ${records} inner join ${conversations} on ${conversations.recordId} = ${records.id} and ${conversations.organizationId} = ${records.organizationId} where ${records.personId} = ${people.id} and ${records.organizationId} = ${people.organizationId} and ${publicConversation})`;

/** Every condition of the filter except the tenant. The tenant condition stays with the caller. */
export function leadFilterCondition(filter: LeadFilter): SQL | undefined {
  const conditions: Array<SQL | undefined> = [leadSearchCondition(filter.query)];
  // The default is `lead`, so a caller that passes `{}` never lists a contact. The literal (not a bound parameter) lets a generic
  // plan use the partial contacts index.
  const lifecycle = lifecycleOf(filter);
  if (lifecycle === "lead") conditions.push(sql`${people.lifecycle} = 'lead'`);
  else if (lifecycle === "contact") conditions.push(sql`${people.lifecycle} = 'contact'`);
  if (filter.campaign === "any") conditions.push(inCampaign(null));
  else if (filter.campaign === "none") conditions.push(sql`not ${inCampaign(null)}`);
  else if (filter.campaign) conditions.push(inCampaign(filter.campaign));
  if (filter.notInCampaign) conditions.push(sql`not ${inCampaign(filter.notInCampaign)}`);
  if (filter.hasEmail !== undefined) conditions.push(filter.hasEmail ? isNotNull(people.email) : isNull(people.email));
  if (filter.hasLinkedin !== undefined) {
    const has = or(isNotNull(people.linkedinSlug), isNotNull(people.linkedinUrl));
    conditions.push(filter.hasLinkedin ? has : sql`not (${has})`);
  }
  if (filter.doNotContact !== undefined) {
    const marked = sql`exists (select 1 from ${contactPolicies} where ${contactPolicies.personId} = ${people.id} and ${contactPolicies.organizationId} = ${people.organizationId} and ${contactPolicies.doNotContact})`;
    conditions.push(filter.doNotContact ? marked : sql`not ${marked}`);
  }
  if (filter.replied !== undefined) conditions.push(filter.replied ? replied : sql`not ${replied}`);
  if (filter.hasConversation !== undefined) conditions.push(filter.hasConversation ? hasPublicConversation : sql`not ${hasPublicConversation}`);
  // Last contact is the later of the latest sent message and any enrollment's `last_sent_at`. The aggregate is a single-row derived table, so the joins run once per lead
  // whichever bounds are set. A lead never contacted has a null maximum, and a null fails both comparisons.
  if (filter.lastContactFrom || filter.lastContactTo) {
    const bounds: SQL[] = [];
    if (filter.lastContactFrom) bounds.push(sql`last_contact.at >= ${filter.lastContactFrom}::date::timestamp at time zone 'UTC'`);
    if (filter.lastContactTo) bounds.push(sql`last_contact.at < (${filter.lastContactTo}::date + 1)::timestamp at time zone 'UTC'`);
    conditions.push(sql`exists (select 1 from (${lastSentAt}) as last_contact where ${sql.join(bounds, sql` and `)})`);
  }
  if (filter.source) conditions.push(sql`(${people.source} = ${filter.source} or split_part(${people.source}, ':', 1) = ${filter.source})`);
  if (filter.createdFrom) conditions.push(sql`${people.createdAt} >= ${filter.createdFrom}::date::timestamp at time zone 'UTC'`);
  if (filter.createdTo) conditions.push(sql`${people.createdAt} < (${filter.createdTo}::date + 1)::timestamp at time zone 'UTC'`);
  if (filter.category) {
    conditions.push(
      sql`exists (select 1 from ${records} where ${records.personId} = ${people.id} and ${records.organizationId} = ${people.organizationId} and ${records.categoryKey} = ${filter.category})`,
    );
  }
  if (filter.ids && filter.ids.length > 0) conditions.push(inArray(people.id, filter.ids));
  return and(...conditions);
}

/**
 * The value the list sorts on, without direction. Text keys compare in lower case; the lead page's neighbor query
 * reads the same expression (with aliased tables for the current lead), so the two cannot drift apart.
 */
export function leadSortExpression(
  key: LeadSort["key"],
  p: Record<"fullName" | "title" | "email" | "createdAt", Column> = people,
  c: Record<"name" | "domain", Column> = companies,
): SQL {
  return {
    name: sql`lower(${p.fullName})`,
    company: sql`lower(coalesce(${c.name}, ${c.domain}))`,
    title: sql`lower(${p.title})`,
    email: sql`lower(${p.email})`,
    created: sql`${p.createdAt}`,
  }[key];
}

/** The order of the lead list. The id breaks ties in the same direction, so pages never skip or repeat a row. */
export function leadOrderBy(sort: LeadSort): SQL[] {
  const direction = sort.dir === "asc" ? sql`asc` : sql`desc`;
  const nulls = sort.key === "created" ? sql`` : sql` nulls last`;
  return [sql`${leadSortExpression(sort.key)} ${direction}${nulls}`, sql`${people.id} ${direction}`];
}

export async function listLeads(
  organizationId: string,
  options: { filter?: LeadFilter; sort?: LeadSort; page?: number; pageSize?: number },
): Promise<{ rows: LeadRow[]; total: number; page: number; pageCount: number; pageSize: number }> {
  const where = and(eq(people.organizationId, organizationId), leadFilterCondition(options.filter ?? {}));

  const [{ total }] = await db
    .select({ total: count() })
    .from(people)
    .leftJoin(companies, eq(companies.id, people.companyId))
    .where(where);

  const pageSize = pickPageSize(options.pageSize);
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(Math.max(1, Math.floor(options.page ?? 1)), pageCount);

  const rows = await db
    .select({
      id: people.id,
      fullName: people.fullName,
      email: people.email,
      title: people.title,
      phone: people.phone,
      linkedinSlug: people.linkedinSlug,
      linkedinUrl: people.linkedinUrl,
      companyName: companies.name,
      companyDomain: companies.domain,
      createdAt: people.createdAt,
      updatedAt: people.updatedAt,
      doNotContact: sql<boolean>`coalesce(${contactPolicies.doNotContact}, false)`,
      lifecycle: people.lifecycle,
      convertedAt: people.convertedAt,
    })
    .from(people)
    .leftJoin(companies, eq(companies.id, people.companyId))
    .leftJoin(contactPolicies, and(eq(contactPolicies.personId, people.id), eq(contactPolicies.organizationId, people.organizationId)))
    .where(where)
    .orderBy(...leadOrderBy(options.sort ?? DEFAULT_LEAD_SORT))
    .limit(pageSize)
    .offset((page - 1) * pageSize);

  return { rows, total, page, pageCount, pageSize };
}

/** Values for the filter dropdowns: campaigns that can be picked and the sources in use. */
export async function leadFilterOptions(organizationId: string): Promise<{
  campaigns: Array<{ id: string; name: string; channel: string }>;
  sources: string[];
  categories: string[];
}> {
  const [campaignRows, sourceRows, categoryRows] = await Promise.all([
    db
      .select({ id: campaigns.id, name: campaigns.name, channel: campaigns.channel })
      .from(campaigns)
      .where(and(eq(campaigns.organizationId, organizationId), isNull(campaigns.archivedAt)))
      .orderBy(asc(campaigns.name), asc(campaigns.id)),
    db
      .selectDistinct({ source: sql<string>`split_part(${people.source}, ':', 1)` })
      .from(people)
      .where(and(eq(people.organizationId, organizationId), isNotNull(people.source))),
    db
      .selectDistinct({ category: records.categoryKey })
      .from(records)
      .where(and(eq(records.organizationId, organizationId), isNotNull(records.categoryKey))),
  ]);
  return {
    campaigns: campaignRows,
    sources: sourceRows.map((r) => r.source).filter(Boolean).sort(),
    categories: categoryRows.map((r) => r.category).filter((c): c is string => c !== null).sort(),
  };
}
