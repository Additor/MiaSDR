import { and, eq, inArray, sql } from "drizzle-orm";
import { db, type DbTx } from "@/platform/db/client";
import { campaignEnrollments, people } from "@/platform/db/schema";
import { suppressAddressTx } from "@/contexts/people/infrastructure/reachability";
import type { FollowUpStop } from "../application/inbound-ports";
import type { SuppressionStore } from "../email/application/unsubscribe";
import { haltOutcome } from "../domain/enrollment-status";
import { endEnrollmentsTx } from "./enrollment-end";

type SuppressInput = Parameters<SuppressionStore["suppressEmail"]>[0];

/**
 * Suppression as outreach runs it: people puts the address on the list, then outreach ends the live email enrollments of
 * every person with that address and hands the halt to conversations, which ends their follow-up runs. One transaction.
 */
export const createSuppressionStore = (followUps: FollowUpStop): SuppressionStore & { suppressEmailTx(tx: DbTx, input: SuppressInput): Promise<{ stopped: number; added: boolean }> } => {
  /** The same writes inside a caller's transaction, so its own writes commit with the suppression or not at all. */
  async function suppressEmailTx(tx: DbTx, { organizationId, email, reason, note, addedInSettings }: SuppressInput) {
    const { email: normalized, added } = await suppressAddressTx(tx, { organizationId, email, reason, note, addedInSettings });
    const now = new Date();
    const addressOwners = tx.select({ id: people.id }).from(people).where(and(eq(people.organizationId, organizationId), sql`lower(${people.email}) = ${normalized}`));
    const stopped = await endEnrollmentsTx(
      tx,
      and(eq(campaignEnrollments.organizationId, organizationId), eq(campaignEnrollments.channel, "email"), inArray(campaignEnrollments.personId, addressOwners)),
      haltOutcome(reason),
      now,
    );
    // The follow-up sequence of a conversation stops in the same commit, with its unsent drafts.
    await followUps.endEmailRunsTx(tx, organizationId, normalized, reason, now);
    return { stopped: stopped.length, added };
  }
  return {
    suppressEmailTx,
    suppressEmail: (input) => db.transaction((tx) => suppressEmailTx(tx, input)),
  };
};
