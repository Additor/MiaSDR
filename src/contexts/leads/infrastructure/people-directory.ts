import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/platform/db/client";
import { companies, contactPolicies, people, suppressionList } from "@/platform/db/schema";
import type { Actor } from "@/shared/errors";
import { leadSearchCondition } from "./queries";

/*
 * Reads over `people` for screens that show a person next to something else (a deal, a reply thread, an unmatched sender),
 * whatever the person's lifecycle. The lead list has its own query (`listLeads`); these do not filter by lifecycle.
 * Every read is scoped to the organization.
 */

export const MAX_PERSON_SUMMARY_IDS = 500;
export const PEOPLE_SEARCH_LIMIT = 20;

export interface PersonSummary {
  id: string;
  /** Full name, else the email, else null. */
  name: string | null;
  email: string | null;
  phone: string | null;
  title: string | null;
  linkedinSlug: string | null;
  linkedinUrl: string | null;
  companyId: string | null;
  companyName: string | null;
  companyDomain: string | null;
  lifecycle: string;
  convertedAt: Date | null;
  doNotContact: boolean;
  /** The address is on the organization's suppression list. */
  suppressed: boolean;
}

/** Summaries of up to 500 people by id, keyed by id. An id of another organization or an unknown id has no entry. */
export async function personSummaries(organizationId: string, ids: readonly string[]): Promise<Map<string, PersonSummary>> {
  const unique = [...new Set(ids)].slice(0, MAX_PERSON_SUMMARY_IDS);
  const result = new Map<string, PersonSummary>();
  if (unique.length === 0) return result;
  const rows = await db
    .select({
      id: people.id,
      fullName: people.fullName,
      email: people.email,
      phone: people.phone,
      title: people.title,
      linkedinSlug: people.linkedinSlug,
      linkedinUrl: people.linkedinUrl,
      companyId: people.companyId,
      companyName: companies.name,
      companyDomain: companies.domain,
      lifecycle: people.lifecycle,
      convertedAt: people.convertedAt,
      doNotContact: sql<boolean>`coalesce(${contactPolicies.doNotContact}, false)`,
      suppressed: sql<boolean>`exists (select 1 from ${suppressionList} where ${suppressionList.organizationId} = ${people.organizationId} and ${suppressionList.email} = lower(${people.email}))`,
    })
    .from(people)
    .leftJoin(companies, and(eq(companies.id, people.companyId), eq(companies.organizationId, people.organizationId)))
    .leftJoin(contactPolicies, and(eq(contactPolicies.personId, people.id), eq(contactPolicies.organizationId, people.organizationId)))
    .where(and(eq(people.organizationId, organizationId), inArray(people.id, unique)));
  for (const { fullName, ...row } of rows) result.set(row.id, { ...row, name: fullName ?? row.email });
  return result;
}

export interface PersonSearchRow {
  personId: string;
  name: string | null;
  email: string | null;
  company: string | null;
  lifecycle: string;
}

/**
 * People whose name, email, title, company, LinkedIn or phone match `q`, any lifecycle, at most 20, in name order. Nothing
 * matches an empty search. The Unmatched senders panel uses it to pick the person a sender belongs to.
 */
export async function searchPeople(actor: Pick<Actor, "organizationId">, q: string): Promise<PersonSearchRow[]> {
  const match = leadSearchCondition(q);
  if (!match) return [];
  const rows = await db
    .select({
      id: people.id,
      fullName: people.fullName,
      email: people.email,
      companyName: companies.name,
      companyDomain: companies.domain,
      lifecycle: people.lifecycle,
    })
    .from(people)
    .leftJoin(companies, and(eq(companies.id, people.companyId), eq(companies.organizationId, people.organizationId)))
    .where(and(eq(people.organizationId, actor.organizationId), match))
    .orderBy(sql`lower(coalesce(${people.fullName}, ${people.email}))`, asc(people.id))
    .limit(PEOPLE_SEARCH_LIMIT);
  return rows.map((r) => ({ personId: r.id, name: r.fullName ?? r.email, email: r.email, company: r.companyName ?? r.companyDomain, lifecycle: r.lifecycle }));
}
