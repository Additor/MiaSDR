import { sql } from "drizzle-orm";
import { isOwnerOrAdmin } from "@/contexts/tenancy/domain/roles";
import { db, type DbHandle } from "@/platform/db/client";
import type { Actor } from "@/shared/errors";
import { LIVE_ENROLLMENT_STATUSES } from "../domain/enrollment-status";
import { SEND_COUNTED } from "../domain/send-status";
import { rowsOf, sqlValues } from "@/platform/db/sql-values";

/*
 * Callee-owned functions for deleting people ("Delete" and "Contact delete" in docs/decisions.md). The people use cases
 * hold the transaction and call these after the person's outreach advisory lock and the people row lock:
 * `lockEnrollmentsOfPeopleTx` first in both modes, then for a contact `personOutreachBlockers`, `personOutreachCounts` and
 * `purgePersonOutreach`, for a batch of leads `leadOutreachBlockers` and `purgeUnsentEnrollments`.
 * `leadsInRunningCampaigns` feeds the merge preview.
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

/** The ids as a uuid `in` list of bound parameters. */
const uuidList = (ids: readonly string[]) => sql`(${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)})`;

const enrollmentsOf = (organizationId: string, personId: string) =>
  sql`(select e.id from campaign_enrollments e where e.organization_id = ${organizationId} and e.person_id = ${personId}::uuid)`;

/**
 * Whether the actor sees campaign `alias`: an owner or admin sees every campaign, a member sees regular campaigns and the
 * personal campaigns they created. A personal campaign whose creator left counts as another member's.
 */
const campaignSeenBy = (actor: Actor, alias: string) => {
  if (isOwnerOrAdmin(actor.role)) return sql`true`;
  const c = sql.raw(alias);
  // `is not distinct from`: a creator who left sets `created_by` to null, and a null here would drop every flag built on it.
  return sql`(${c}.type = 'regular' or ${c}.created_by is not distinct from ${actor.userId}::uuid)`;
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
 * The enrollments of these people `FOR UPDATE` in id order. A send claim selects its enrollment `FOR UPDATE SKIP LOCKED` and
 * inserts the send under that lock, so while a delete holds these rows no claim takes them, and a claim that holds one makes
 * the delete wait until it commits and then shows in the blockers. Returns how many it locked.
 */
export async function lockEnrollmentsOfPeopleTx(tx: DbHandle, organizationId: string, personIds: readonly string[]): Promise<number> {
  if (personIds.length === 0) return 0;
  const rows = rowsOf<{ id: string }>(
    await tx.execute(sql`
      select e.id from campaign_enrollments e
      where e.organization_id = ${organizationId} and e.person_id in ${uuidList(personIds)}
      order by e.id for update of e`),
  );
  return rows.length;
}

export type LeadOutreachBlocker = "has_sends" | "has_hidden_sends" | "personal_campaign_sends" | "in_active_campaign";

/**
 * The outreach blockers of a lead delete, per person, in one statement. `has_sends`: a counted send (`sending`, `sent` or
 * `unknown`) in a campaign the actor sees; `has_hidden_sends`: one in a campaign the actor does not see. A lead whose sends
 * all failed has neither. `personal_campaign_sends`: for a member, an enrollment in a personal campaign another member
 * created, sent or not. `in_active_campaign`: a `pending` or `active` enrollment in an active or paused campaign. The time
 * windows of a contact delete do not apply: a lead with a counted send stays anyway.
 */
export async function leadOutreachBlockers(tx: DbHandle, actor: Actor, personIds: readonly string[]): Promise<Map<string, LeadOutreachBlocker[]>> {
  const found = new Map<string, LeadOutreachBlocker[]>();
  if (personIds.length === 0) return found;
  const org = actor.organizationId;
  const rows = rowsOf<{ person_id: string; seen_sends: boolean; hidden_sends: boolean; personal: boolean; running: boolean }>(
    await tx.execute(sql`
      with enr as (
        select e.id, e.person_id, e.status, c.status as campaign_status, ${campaignSeenBy(actor, "c")} as seen,
          exists (select 1 from sends s where s.organization_id = e.organization_id and s.enrollment_id = e.id and s.status in ${sqlValues(SEND_COUNTED)}) as counted
        from campaign_enrollments e join campaigns c on c.id = e.campaign_id and c.organization_id = e.organization_id
        where e.organization_id = ${org} and e.person_id in ${uuidList(personIds)}
      )
      select person_id,
        bool_or(counted and seen) as seen_sends,
        bool_or(counted and not seen) as hidden_sends,
        bool_or(not seen) as personal,
        bool_or(status in ${sqlValues(LIVE_ENROLLMENT_STATUSES)} and campaign_status in ('active', 'paused')) as running
      from enr group by person_id`),
  );
  for (const row of rows) {
    const reasons: LeadOutreachBlocker[] = [];
    if (row.seen_sends) reasons.push("has_sends");
    if (row.hidden_sends) reasons.push("has_hidden_sends");
    if (row.personal) reasons.push("personal_campaign_sends");
    if (row.running) reasons.push("in_active_campaign");
    if (reasons.length > 0) found.set(row.person_id, reasons);
  }
  return found;
}

/**
 * Deletes the sends of these people's enrollments, then the enrollments. `sends_enrollment_fk` is NO ACTION, so the sends go
 * first, and the sends trigger refuses a send in flight or unresolved (`sending`, `unknown`), which the blockers ruled out.
 * The enrollment delete cascades to their LinkedIn details and sets `linkedin_connections.enrollment_id` to null.
 */
async function purgeOutreachOf(tx: DbHandle, organizationId: string, personIds: readonly string[]): Promise<{ enrollments: number; sends: number }> {
  if (personIds.length === 0) return { enrollments: 0, sends: 0 };
  const enrollments = sql`(select e.id from campaign_enrollments e where e.organization_id = ${organizationId} and e.person_id in ${uuidList(personIds)})`;
  const [gone] = rowsOf<{ n: number }>(
    await tx.execute(sql`with gone as (delete from sends where organization_id = ${organizationId} and enrollment_id in ${enrollments} returning 1) select count(*)::int as n from gone`),
  );
  const [left] = rowsOf<{ n: number }>(
    await tx.execute(sql`
      with gone as (delete from campaign_enrollments where organization_id = ${organizationId} and person_id in ${uuidList(personIds)} returning 1)
      select count(*)::int as n from gone`),
  );
  return { enrollments: left.n, sends: gone.n };
}

/** The last outreach step of a contact delete. Campaign reports read these rows live, so they drop the sends (P2). */
export const purgePersonOutreach = (tx: DbHandle, organizationId: string, personId: string) => purgeOutreachOf(tx, organizationId, [personId]);

/** The outreach step of a lead delete. The blockers left these leads only failed sends, so nothing that reached a person goes. */
export const purgeUnsentEnrollments = (tx: DbHandle, organizationId: string, personIds: readonly string[]) => purgeOutreachOf(tx, organizationId, personIds);

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
