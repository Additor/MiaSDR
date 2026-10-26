import { sql } from "drizzle-orm";
import type { DbHandle } from "@/platform/db/client";
import type { DealStageKind } from "../domain/stages";
import type { DealTitleParts } from "../application/deal-ports";
import { rowsOf } from "@/platform/db/sql-values";

/*
 * The deals side of a contact delete ("Contacts and Companies CRUD" in docs/decisions.md).
 * Callee-owned functions with no route: the leads use case calls them through its ports, in its own transaction, after it
 * holds the person's records, advisory lock and people row. Every statement filters by organization.
 */

/** A won deal's title goes into the delete dialog when the person has this many won deals or fewer. */
export const WON_TITLES_LIMIT = 3;

export interface PersonDealLock {
  id: string;
  title: string;
  stageName: string;
  stageKind: DealStageKind;
}

/**
 * Step 4: every deal of the person `FOR UPDATE`, in id order. A deal in an open stage blocks the delete (`open_deals`). A stage
 * move that commits first shows here; one that comes later waits on these rows and then finds no deal.
 */
export async function lockDealsOfPerson(tx: DbHandle, organizationId: string, personId: string): Promise<PersonDealLock[]> {
  const rows = rowsOf<{ id: string; title: string; stage_name: string; stage_kind: string }>(
    await tx.execute(sql`
      select d.id, d.title, s.name as stage_name, d.stage_kind
      from deals d join deal_stages s on s.id = d.stage_id and s.organization_id = d.organization_id
      where d.organization_id = ${organizationId} and d.person_id = ${personId}::uuid
      order by d.id
      for update of d`),
  );
  return rows.map((row) => ({ id: row.id, title: row.title, stageName: row.stage_name, stageKind: row.stage_kind as DealStageKind }));
}

/** Won and lost deals of the person. `wonTitles` lists the won deals' titles, newest close first, when there are 3 or fewer. */
export async function dealCountsOfPerson(tx: DbHandle, organizationId: string, personId: string): Promise<{ won: number; lost: number; wonTitles: string[] }> {
  const rows = rowsOf<{ stage_kind: string; title: string }>(
    await tx.execute(sql`
      select d.stage_kind, d.title
      from deals d
      where d.organization_id = ${organizationId} and d.person_id = ${personId}::uuid and d.stage_kind in ('won', 'lost')
      order by d.closed_at desc nulls last, d.id`),
  );
  const won = rows.filter((row) => row.stage_kind === "won");
  return { won: won.length, lost: rows.length - won.length, wonTitles: won.length <= WON_TITLES_LIMIT ? won.map((row) => row.title) : [] };
}

/**
 * Step 11: deletes the person's won and lost deals. It writes no `deal.deleted` event, because the person's events go with the
 * person. An open deal stays, so `deals_person_fk` (RESTRICT) refuses the person delete if one slipped past the blocker.
 */
export async function deleteClosedDealsOfPerson(tx: DbHandle, organizationId: string, personId: string): Promise<{ deleted: number }> {
  const rows = rowsOf<{ id: string }>(
    await tx.execute(sql`delete from deals where organization_id = ${organizationId} and person_id = ${personId}::uuid and stage_kind <> 'open' returning id`),
  );
  return { deleted: rows.length };
}

/** The name (full name, else email) and company name of a person in the caller's transaction, for a new contact's deal title. */
export const dealTitleParts: DealTitleParts = async (tx, organizationId, personId) => {
  const [row] = rowsOf<{ name: string | null; company_name: string | null }>(
    await tx.execute(sql`
      select coalesce(p.full_name, p.email) as name, c.name as company_name
      from people p left join companies c on c.id = p.company_id and c.organization_id = p.organization_id
      where p.organization_id = ${organizationId} and p.id = ${personId}::uuid`),
  );
  return row ? { name: row.name, companyName: row.company_name } : null;
};
