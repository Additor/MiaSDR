import { sql } from "drizzle-orm";
import type { DbTx } from "@/platform/db/client";
import type { FitCriterion, FitInputs, FitVerdict } from "../domain/lead-fit";

export interface LeadFitRecord {
  organizationId: string;
  personId: string;
  verdict: FitVerdict;
  icpItemId: string | null;
  criteria: FitCriterion[];
  missing: string[];
  inputs: FitInputs;
  runId: string;
  provider: string;
  model: string;
  assessedBy: string | null;
  assessedAt: Date;
}

/**
 * Stores a judgment in place of the last one, inside the caller's transaction, so Mia ends its run and saves the result
 * together. False when the person is gone: the insert reads the person, so a deleted one writes nothing and fails nothing.
 */
export async function saveLeadFitTx(tx: DbTx, record: LeadFitRecord): Promise<boolean> {
  const rows = (await tx.execute(sql`
    insert into lead_fit_assessments (person_id, organization_id, verdict, icp_item_id, criteria, missing, brain_revisions, profile_hash, latest_inbound_message_id, run_id, provider, model, assessed_by, assessed_at)
    select p.id, p.organization_id, ${record.verdict},
      -- An ICP deleted since the run read it is no key to keep.
      (select k.id from knowledge_documents k where k.id = ${record.icpItemId}::uuid and k.organization_id = p.organization_id),
      ${JSON.stringify(record.criteria)}::jsonb, ${JSON.stringify(record.missing)}::jsonb,
      ${JSON.stringify(record.inputs.brainRevisions)}::jsonb, ${record.inputs.profileHash}, ${record.inputs.latestInboundMessageId}::uuid, ${record.runId}::uuid,
      ${record.provider}, ${record.model},
      -- A person who started the check and left since is no key to keep either; a missing one would fail the write and repeat the paid call.
      (select u.id from users u where u.id = ${record.assessedBy}::uuid), ${record.assessedAt.toISOString()}::timestamptz
    from people p
    where p.id = ${record.personId}::uuid and p.organization_id = ${record.organizationId}::uuid
    on conflict (person_id) do update set
      verdict = excluded.verdict, icp_item_id = excluded.icp_item_id, criteria = excluded.criteria, missing = excluded.missing,
      brain_revisions = excluded.brain_revisions, profile_hash = excluded.profile_hash, latest_inbound_message_id = excluded.latest_inbound_message_id,
      run_id = excluded.run_id, provider = excluded.provider, model = excluded.model, assessed_by = excluded.assessed_by, assessed_at = excluded.assessed_at
    returning person_id
  `)) as unknown as unknown[];
  return rows.length > 0;
}
