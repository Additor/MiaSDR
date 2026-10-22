import { createHistoryPruneJob } from "./prune";
import { createDailyRolloverJob, type RolloverStep } from "./rollover";
import type { Job } from "./types";

/** Platform jobs that belong to no bounded context: daily rollover and history pruning. src/composition passes the rollover steps. */
export function maintenanceJobs(rolloverSteps: readonly RolloverStep[]): Job[] {
  return [createDailyRolloverJob(rolloverSteps), createHistoryPruneJob()];
}
