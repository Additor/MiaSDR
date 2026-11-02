import type { DbHandle } from "@/platform/db/client";
import { ConflictError } from "@/shared/errors";
import type { CampaignStatus } from "../domain/campaign";

/** How an enroll call may run, beyond the people it names. The four enroll use cases of both channels take it. */
export interface EnrollOptions {
  /** The campaign statuses this caller may enroll into. A campaign in another status answers 409 `campaign_status`. */
  allowedStatuses?: readonly CampaignStatus[];
  /** Counts what the call would do and rolls it back. */
  dryRun?: boolean;
}

class RolledBack<T> {
  constructor(readonly result: T) {}
}

const refuse = (status: CampaignStatus) =>
  new ConflictError(`This campaign is ${status}, and this caller may not add leads to a ${status} campaign.`, { code: "campaign_status", status });

/**
 * Runs an enroll in one transaction under `options`. The status is read before the work and again after it: the
 * enrollment insert waits on a start that holds the campaign row, so the second read sees a start that committed in
 * between, and the throw rolls the enrollment back. A dry run rolls back whatever it did and answers its counts.
 */
export async function enrollUnder<T>(
  campaigns: { transaction<R>(fn: (tx: DbHandle) => Promise<R>, within?: DbHandle): Promise<R> },
  statusOf: (tx: DbHandle) => Promise<CampaignStatus>,
  options: EnrollOptions,
  tx: DbHandle | undefined,
  work: (tx: DbHandle | undefined) => Promise<T>,
): Promise<T> {
  const allowed = options.allowedStatuses;
  if (!allowed && !options.dryRun) return work(tx);
  try {
    return await campaigns.transaction(async (t) => {
      const check = async () => {
        const status = await statusOf(t);
        if (allowed && !allowed.includes(status)) throw refuse(status);
      };
      await check();
      const result = await work(t);
      await check();
      if (options.dryRun) throw new RolledBack(result);
      return result;
    }, tx);
  } catch (error) {
    if (error instanceof RolledBack) return error.result as T;
    throw error;
  }
}
