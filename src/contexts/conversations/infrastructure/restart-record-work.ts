import { sql } from "drizzle-orm";
import { startRun } from "../after-reply/application/sequences";
import { createRunOn, loadStartOn } from "../after-reply/infrastructure/drizzle-sequence-store";
import type { DbTx as Tx } from "@/platform/db/client";
import { rowsOf } from "@/platform/db/sql-values";
import { interruptRecordRunsTx } from "../after-reply/infrastructure/sequence-stop";
import { staleOpenDraftsTx } from "./stale-drafts-sql";

/**
 * A person changed what the record is: a stage move or a corrected classification. Work that was prepared for the old
 * reading of the thread ends in the same transaction, and the owning campaign's flow starts from the new one.
 *
 * 1. Open drafts retire (`stale`), so nobody sends a reply written for the old stage.
 * 2. The active or paused sequence run ends as `interrupted` with `reason`.
 * 3. `context_version` goes up by one, so draft and classification jobs queued for the old version skip.
 * 4. A new run starts when the campaign that most recently emailed the person has After a reply on and the new
 *    subcategory wants a reply; otherwise no run starts.
 *
 * The caller holds the record's lock and has already written the new category. Undo only ends work, so it calls
 * `interruptRecordRunsTx` and retires drafts itself.
 */
export type RestartReason = "stage_moved" | "classification_corrected";

export interface RestartResult {
  contextVersion: number;
  draftsRetired: number;
  runsEnded: number;
  runStarted: boolean;
}

export async function restartRecordWorkTx(
  tx: Tx,
  input: { organizationId: string; recordId: string; reason: RestartReason; draftReason: string; now: Date; actorUserId: string },
): Promise<RestartResult> {
  const draftsRetired = await staleOpenDraftsTx(tx, { organizationId: input.organizationId, recordId: input.recordId, reason: input.draftReason, now: input.now });
  const runsEnded = await interruptRecordRunsTx(tx, input.organizationId, input.recordId, input.reason, input.now);
  const [bumped] = rowsOf<{ context_version: number }>(
    await tx.execute(sql`update records set context_version = context_version + 1 where id = ${input.recordId} and organization_id = ${input.organizationId} returning context_version`),
  );

  // The same code that starts a run for a new reply, bound to this transaction, so a failed start rolls the change back.
  const started = await startRun(
    {
      now: () => input.now,
      runs: {
        loadStart: (organizationId, recordId, opts) => loadStartOn(tx, organizationId, recordId, opts),
        createRun: (run) => createRunOn(tx, run),
      },
    },
    { organizationId: input.organizationId, recordId: input.recordId, source: "ai_assignment", actorUserId: input.actorUserId },
  );
  return { contextVersion: bumped.context_version, draftsRetired, runsEnded, runStarted: Boolean(started?.created) };
}
