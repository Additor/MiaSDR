import { and, count, eq, ilike, inArray, isNotNull, isNull, or, sql, type Column, type SQL } from "drizzle-orm";
import { db } from "@/platform/db/client";
import { companies, contactPolicies, people } from "@/platform/db/schema";
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
 * The conditions of the lead filter on other contexts' tables: campaign membership, Replied, conversation, last contact
 * and CRM category. `activityCondition` in `src/read-models/lead-activity.ts` defines them, and `src/composition/leads.ts`
 * passes it to every lead read built here, so no read can leave those filters out.
 */
export type ActivityCondition = (filter: LeadFilter) => SQL | undefined;

/** The conditions of the filter on people's own tables (`people`, `companies`, `contact_policies`). */
function peopleCondition(filter: LeadFilter): SQL | undefined {
  const conditions: Array<SQL | undefined> = [leadSearchCondition(filter.query)];
  // The default is `lead`, so a caller that passes `{}` never lists a contact. The literal (not a bound parameter) lets a generic
  // plan use the partial contacts index.
  const lifecycle = lifecycleOf(filter);
  if (lifecycle === "lead") conditions.push(sql`${people.lifecycle} = 'lead'`);
  else if (lifecycle === "contact") conditions.push(sql`${people.lifecycle} = 'contact'`);
  if (filter.hasEmail !== undefined) conditions.push(filter.hasEmail ? isNotNull(people.email) : isNull(people.email));
  if (filter.hasLinkedin !== undefined) {
    const has = or(isNotNull(people.linkedinSlug), isNotNull(people.linkedinUrl));
    conditions.push(filter.hasLinkedin ? has : sql`not (${has})`);
  }
  if (filter.doNotContact !== undefined) {
    const marked = sql`exists (select 1 from ${contactPolicies} where ${contactPolicies.personId} = ${people.id} and ${contactPolicies.organizationId} = ${people.organizationId} and ${contactPolicies.doNotContact})`;
    conditions.push(filter.doNotContact ? marked : sql`not ${marked}`);
  }
  if (filter.source) conditions.push(sql`(${people.source} = ${filter.source} or split_part(${people.source}, ':', 1) = ${filter.source})`);
  if (filter.createdFrom) conditions.push(sql`${people.createdAt} >= ${filter.createdFrom}::date::timestamp at time zone 'UTC'`);
  if (filter.createdTo) conditions.push(sql`${people.createdAt} < (${filter.createdTo}::date + 1)::timestamp at time zone 'UTC'`);
  if (filter.ids && filter.ids.length > 0) conditions.push(inArray(people.id, filter.ids));
  return and(...conditions);
}

/** Every condition of the filter, people's and the activity's, scoped to the organization. Reads join `companies` for the search. */
export function leadFilterWhere(organizationId: string, filter: LeadFilter, activity: ActivityCondition): SQL | undefined {
  return and(eq(people.organizationId, organizationId), peopleCondition(filter), activity(filter));
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

export type ListLeads = (
  organizationId: string,
  options: { filter?: LeadFilter; sort?: LeadSort; page?: number; pageSize?: number },
) => Promise<{ rows: LeadRow[]; total: number; page: number; pageCount: number; pageSize: number }>;

/** The lead list: one page of the filtered leads in the list order, and the total. */
export const createListLeads = (activity: ActivityCondition): ListLeads => async (organizationId, options) => {
  const where = leadFilterWhere(organizationId, options.filter ?? {}, activity);

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
};
