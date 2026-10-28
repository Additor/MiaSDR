import { sql } from "drizzle-orm";
import { isOwnerOrAdmin } from "@/contexts/tenancy/domain/roles";
import { db, type DbHandle } from "@/platform/db/client";
import type { Actor } from "@/shared/errors";
import { LIVE_ENROLLMENT_STATUSES } from "../domain/enrollment-status";
import { rowsOf, sqlValues } from "@/platform/db/sql-values";

/*
 * Callee-owned functions for deleting a contact ("Contacts and Companies CRUD" in docs/decisions.md). The
 * leads use case holds the transaction and calls these after `lockPersonForDelete`, which takes the person's outreach
 * advisory lock, and the people row lock: `personOutreachBlockers` (step 5), `personOutreachCounts` (step 8) and
 * `purgePersonOutreach` (step 12). `leadsInRunningCampaigns` feeds the merge preview.
 */

const HOUR_MS = 60 * 60 * 1000;
/** A campaign send this recent blocks a delete, so today's mailbox limit keeps counting it (P3). */
export const RECENT_SEND_MS = 24 * HOUR_MS;
/** A LinkedIn invitation this recent blocks a delete, so the weekly invitation cap keeps counting it (P3). */
export const RECENT_INVITE_MS = 7 * 24 * HOUR_MS;

export interface PersonOutreachCounts {
  /** Enrollments of the person, one per campaign. */
  campaigns: number;
  sends: number;
  /** The person has an enrollment in another member's personal campaign, which the counts leave out. */
  hidden: boolean;
}

export type PersonOutreachBlocker =
  | { reason: "send_in_flight" }
  | { reason: "recent_send"; until: Date }
  | { reason: "recent_invite"; until: Date }
  | { reason: "personal_campaign_sends" };

const enrollmentsOf = (organizationId: string, personId: string) =>
  sql`(select e.id from campaign_enrollments e where e.organization_id = ${organizationId} and e.person_id = ${personId}::uuid)`;

/**
 * Whether the actor sees campaign `alias`: an owner or admin sees every campaign, a member sees regular campaigns and the
 * personal campaigns they created. A personal campaign whose creator left counts as another member's.
 */
const campaignSeenBy = (actor: Actor, alias: string) => {
  if (isOwnerOrAdmin(actor.role)) return sql`true`;
  const c = sql.raw(alias);
  return sql`(${c}.type = 'regular' or ${c}.created_by = ${actor.userId}::uuid)`;
};

/**
 * What a contact delete removes in this context, as the actor may see it: the person's enrollments and their sends, which
 * `purgePersonOutreach` deletes. Enrollments in another member's personal campaign stay out of a member's counts.
 */
export async function personOutreachCounts(tx: DbHandle, actor: Actor, personId: string): Promise<PersonOutreachCounts> {
  const org = actor.organizationId;
  const [row] = rowsOf<PersonOutreachCounts>(
    await tx.execute(sql`
      with enr as (
        select e.id, ${campaignSeenBy(actor, "c")} as seen
        from campaign_enrollments e join campaigns c on c.id = e.campaign_id and c.organization_id = e.organization_id
        where e.organization_id = ${org} and e.person_id = ${personId}::uuid
      )
      select
        (select count(*) from enr where seen)::int as campaigns,
        (select count(*) from sends s where s.organization_id = ${org} and s.enrollment_id in (select id from enr where seen))::int as sends,
        exists (select 1 from enr where not seen) as hidden`),
  );
  return row;
}

/**
 * Step 5 of a contact delete. `send_in_flight`: a campaign send to the person is claimed and not confirmed (`sending`) or
 * needs reconciliation (`unknown`). `recent_send`: a campaign send claimed in the last 24 hours, which today's mailbox limit
 * counts; test sends have no enrollment and use no campaign limit, so they never block. `recent_invite`: a LinkedIn step 1
 * send claimed in the last 7 days, the window of the weekly invitation cap. `until` is when the newest such send leaves its
 * window. `personal_campaign_sends`: for a member, an enrollment (and so any send) in a personal campaign the member did not
 * create. Owners and admins pass that rule. `now` is the caller's clock.
 */
export async function personOutreachBlockers(tx: DbHandle, actor: Actor, personId: string, now: Date): Promise<PersonOutreachBlocker[]> {
  const org = actor.organizationId;
  const enrollments = enrollmentsOf(org, personId);
  const sendWindow = new Date(now.getTime() - RECENT_SEND_MS).toISOString();
  const inviteWindow = new Date(now.getTime() - RECENT_INVITE_MS).toISOString();
  const personalCheck = isOwnerOrAdmin(actor.role)
    ? sql`false`
    : sql`exists (
        select 1 from campaign_enrollments e join campaigns c on c.id = e.campaign_id and c.organization_id = e.organization_id
        where e.organization_id = ${org} and e.person_id = ${personId}::uuid and c.type = 'personal' and c.created_by is distinct from ${actor.userId}::uuid
      )`;
  const [row] = rowsOf<{ in_flight: boolean; last_send: string | Date | null; last_invite: string | Date | null; personal: boolean }>(
    await tx.execute(sql`
      select
        exists (
          select 1 from sends s where s.organization_id = ${org} and s.enrollment_id in ${enrollments} and s.status in ('sending', 'unknown')
        ) as in_flight,
        (select max(s.claimed_at) from sends s
          where s.organization_id = ${org} and s.kind = 'campaign' and s.enrollment_id in ${enrollments}
            and s.claimed_at > ${sendWindow}::timestamptz) as last_send,
        (select max(s.claimed_at) from sends s
          where s.organization_id = ${org} and s.kind = 'campaign' and s.enrollment_id in ${enrollments}
            and s.channel = 'linkedin' and s.step_number = 1 and s.claimed_at > ${inviteWindow}::timestamptz) as last_invite,
        ${personalCheck} as personal`),
  );
  const blockers: PersonOutreachBlocker[] = [];
  if (row.in_flight) blockers.push({ reason: "send_in_flight" });
  if (row.last_send) blockers.push({ reason: "recent_send", until: new Date(new Date(row.last_send).getTime() + RECENT_SEND_MS) });
  if (row.last_invite) blockers.push({ reason: "recent_invite", until: new Date(new Date(row.last_invite).getTime() + RECENT_INVITE_MS) });
  if (row.personal) blockers.push({ reason: "personal_campaign_sends" });
  return blockers;
}

/**
 * Step 12 of a contact delete: removes the person's enrollments. The delete cascades to their sends and LinkedIn details,
 * and sets `linkedin_connections.enrollment_id` to null. Campaign reports read these rows live, so they drop the sends (P2).
 */
export async function purgePersonOutreach(tx: DbHandle, organizationId: string, personId: string): Promise<{ enrollments: number; sends: number }> {
  const enrollments = enrollmentsOf(organizationId, personId);
  const [row] = rowsOf<{ enrollments: number; sends: number }>(
    await tx.execute(sql`
      with gone_sends as (select count(*)::int as n from sends where organization_id = ${organizationId} and enrollment_id in ${enrollments}),
      gone as (delete from campaign_enrollments where organization_id = ${organizationId} and person_id = ${personId}::uuid returning 1)
      select (select count(*) from gone)::int as enrollments, (select n from gone_sends) as sends`),
  );
  return row;
}

/**
 * For the merge preview: leads of the company with a `pending` or `active` enrollment in an `active` campaign. Their next
 * emails render the kept company's name after a merge.
 */
export async function leadsInRunningCampaigns(organizationId: string, companyId: string): Promise<number> {
  const [row] = rowsOf<{ n: number }>(
    await db.execute(sql`
      select count(distinct p.id)::int as n
      from people p
      join campaign_enrollments e on e.person_id = p.id and e.organization_id = p.organization_id
      join campaigns c on c.id = e.campaign_id and c.organization_id = e.organization_id
      where p.organization_id = ${organizationId} and p.company_id = ${companyId}::uuid and p.lifecycle = 'lead'
        and e.status in ${sqlValues(LIVE_ENROLLMENT_STATUSES)} and c.status = 'active'`),
  );
  return row.n;
}
