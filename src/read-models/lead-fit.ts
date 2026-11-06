import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/platform/db/client";
import { knowledgeDocuments, miaRuns } from "@/platform/db/schema";
import { AUTOMATED_SENDER_PATTERN, AUTOMATED_SUBJECT_PATTERN } from "@/contexts/conversations/domain/inbox-filter";
import { fitChanged, type FitCriterion, type FitVerdict } from "@/contexts/people/domain/lead-fit";
import { fitProfileHash } from "@/contexts/people/domain/lead-fit-hash";
import { MIA_ACTIVE_STATUSES } from "@/contexts/mia/domain/mia-run";

/**
 * A lead's fit as the Leads list and the lead page show it, with whether what the judgment read has changed since:
 * the profile and company fields it sent, the newest reply, and the ICP and qualification items. The newest reply skips
 * machine mail with the rule Mia's fit inputs use (`mia/infrastructure/fit-inputs.ts`), so a bounce asks for nothing.
 */

export interface LeadFitBadge {
  verdict: FitVerdict;
  /** Something the judgment read has changed, so it may be out of date. */
  changed: boolean;
}

export interface LeadFitView extends LeadFitBadge {
  criteria: FitCriterion[];
  missing: string[];
  icpTitle: string | null;
  assessedAt: Date;
}

interface StoredRow {
  person_id: string;
  verdict: FitVerdict;
  criteria: FitCriterion[];
  missing: string[];
  brain_revisions: Record<string, number>;
  profile_hash: string;
  latest_inbound_message_id: string | null;
  assessed_at: string;
  icp_title: string | null;
  full_name: string | null;
  title: string | null;
  custom: Record<string, unknown>;
  company_name: string | null;
  company_domain: string | null;
  company_custom: Record<string, unknown> | null;
  newest_inbound: string | null;
}

async function storedFits(organizationId: string, personIds: readonly string[]): Promise<StoredRow[]> {
  if (personIds.length === 0) return [];
  const ids = sql.join(
    personIds.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
  return (await db.execute(sql`
    select a.person_id, a.verdict, a.criteria, a.missing, a.brain_revisions, a.profile_hash, a.latest_inbound_message_id, a.assessed_at,
      k.title as icp_title, p.full_name, p.title, p.custom, c.name as company_name, c.domain as company_domain, c.custom as company_custom,
      (select m.id from messages m
        join threads t on t.id = m.thread_id and t.organization_id = m.organization_id
        join conversations cv on cv.id = t.conversation_id and cv.organization_id = t.organization_id
        where cv.organization_id = a.organization_id and cv.person_id = a.person_id and m.direction = 'inbound'
          and not (coalesce(m.from_address, '') ~* ${AUTOMATED_SENDER_PATTERN}::text or coalesce(m.subject, '') ~* ${AUTOMATED_SUBJECT_PATTERN}::text)
        order by m.sent_at desc, m.id desc limit 1) as newest_inbound
    from lead_fit_assessments a
    join people p on p.id = a.person_id and p.organization_id = a.organization_id
    left join companies c on c.id = p.company_id and c.organization_id = p.organization_id
    left join knowledge_documents k on k.id = a.icp_item_id and k.organization_id = a.organization_id
    where a.organization_id = ${organizationId}::uuid and a.person_id in (${ids})
  `)) as unknown as StoredRow[];
}

/** The ICP and qualification items a check would read now, by id, with their revision. */
async function currentBrain(organizationId: string): Promise<Record<string, number>> {
  const rows = await db
    .select({ id: knowledgeDocuments.id, revision: knowledgeDocuments.revision })
    .from(knowledgeDocuments)
    .where(and(eq(knowledgeDocuments.organizationId, organizationId), eq(knowledgeDocuments.active, true), inArray(knowledgeDocuments.kind, ["icp", "qualification"])));
  return Object.fromEntries(rows.map((r) => [r.id, r.revision]));
}

function view(row: StoredRow, brain: Record<string, number>): LeadFitView {
  const profileHash = fitProfileHash({ fullName: row.full_name, title: row.title, custom: row.custom, companyName: row.company_name, companyDomain: row.company_domain, companyCustom: row.company_custom ?? {} });
  const changed = fitChanged(
    { profileHash: row.profile_hash, latestInboundMessageId: row.latest_inbound_message_id, brainRevisions: row.brain_revisions },
    { profileHash, latestInboundMessageId: row.newest_inbound, brainRevisions: brain },
  );
  return { verdict: row.verdict, changed, criteria: row.criteria, missing: row.missing, icpTitle: row.icp_title, assessedAt: new Date(row.assessed_at) };
}

/** The badge of each lead that has a judgment. A lead without one has no entry. */
export async function leadFitBadges(organizationId: string, personIds: readonly string[]): Promise<Map<string, LeadFitBadge>> {
  const [rows, brain] = await Promise.all([storedFits(organizationId, personIds), currentBrain(organizationId)]);
  return new Map(
    rows.map((row) => {
      const { verdict, changed } = view(row, brain);
      return [row.person_id, { verdict, changed }];
    }),
  );
}

/** One lead's judgment, and whether a check is going for it now. */
export async function readLeadFit(organizationId: string, personId: string): Promise<{ fit: LeadFitView | null; checking: boolean }> {
  const [rows, brain, going] = await Promise.all([
    storedFits(organizationId, [personId]),
    currentBrain(organizationId),
    db
      .select({ id: miaRuns.id })
      .from(miaRuns)
      .where(and(eq(miaRuns.organizationId, organizationId), eq(miaRuns.personId, personId), eq(miaRuns.capability, "lead_fit"), inArray(miaRuns.status, [...MIA_ACTIVE_STATUSES])))
      .limit(1),
  ]);
  return { fit: rows[0] ? view(rows[0], brain) : null, checking: going.length > 0 };
}
