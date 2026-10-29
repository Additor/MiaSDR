import { and, eq, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db } from "@/platform/db/client";
import { companies, people } from "@/platform/db/schema";
import type { LeadFilter, LeadSort } from "../domain/lead-filter";
import { leadFilterWhere, leadSortExpression, type ActivityCondition } from "./queries";

export interface LeadNeighbors {
  prevId: string | null;
  nextId: string | null;
}

/**
 * The lead before and the lead after one lead in a list order, for the previous and next links of the lead page.
 *
 * Keyset, not offset: the current lead's sort value is read inside the same statement (an aliased copy of `people`
 * and `companies`), and the neighbor is the first row after or before it in the order of `leadOrderBy`, ties broken by
 * id in the same direction. Rows come from the same filter condition as the list, scoped to the organization, so a
 * lead that does not match the filter anymore (edited since) still finds its place by its own values. Nothing is
 * counted or paged: each side is one indexed lookup that stops at the first row (`people_org_created_idx`,
 * `people_org_name_idx`; the other sort keys sort the filtered set like the list does).
 *
 * Text sorts put nulls last, so "after" includes every null and "before" excludes them unless the current value is null.
 */
export type ReadLeadNeighbors = (organizationId: string, personId: string, context: { filter: LeadFilter; sort: LeadSort }) => Promise<LeadNeighbors>;

export const createReadLeadNeighbors = (activity: ActivityCondition): ReadLeadNeighbors => async (organizationId, personId, context) => {
  const { filter, sort } = context;
  const cur = alias(people, "cur");
  const curCompany = alias(companies, "cur_company");
  const a = leadSortExpression(sort.key);
  const k = leadSortExpression(sort.key, cur, curCompany);
  const asc = sort.dir === "asc";
  const forward = asc ? sql`>` : sql`<`;
  const backward = asc ? sql`<` : sql`>`;

  const after: SQL = sql`((${k} is not null and (${a} ${forward} ${k} or (${a} = ${k} and ${people.id} ${forward} ${cur.id}) or ${a} is null)) or (${k} is null and ${a} is null and ${people.id} ${forward} ${cur.id}))`;
  const before: SQL = sql`((${k} is not null and (${a} ${backward} ${k} or (${a} = ${k} and ${people.id} ${backward} ${cur.id}))) or (${k} is null and (${a} is not null or (${a} is null and ${people.id} ${backward} ${cur.id}))))`;

  const find = async (side: SQL, order: SQL[]): Promise<string | null> => {
    const [row] = await db
      .select({ id: people.id })
      .from(people)
      .leftJoin(companies, eq(companies.id, people.companyId))
      .innerJoin(cur, and(eq(cur.id, personId), eq(cur.organizationId, organizationId)))
      .leftJoin(curCompany, eq(curCompany.id, cur.companyId))
      .where(and(leadFilterWhere(organizationId, filter, activity), side))
      .orderBy(...order)
      .limit(1);
    return row?.id ?? null;
  };

  const dir = asc ? sql`asc` : sql`desc`;
  const nulls = sort.key === "created" ? sql`` : sql` nulls last`;
  const reverse = asc ? sql`desc` : sql`asc`;
  const reverseNulls = sort.key === "created" ? sql`` : sql` nulls first`;
  const [nextId, prevId] = await Promise.all([
    find(after, [sql`${a} ${dir}${nulls}`, sql`${people.id} ${dir}`]),
    find(before, [sql`${a} ${reverse}${reverseNulls}`, sql`${people.id} ${reverse}`]),
  ]);
  return { prevId, nextId };
};
