import { createHistoryPruneJob } from "./prune";
import { createDailyRolloverJob } from "./rollover";
import { rolloverSteps } from "./rollover-registry";
import type { Job } from "./types";

/** Platform jobs that belong to no bounded context: daily rollover and history pruning. */
export function maintenanceJobs(): Job[] {
  return [createDailyRolloverJob(rolloverSteps()), createHistoryPruneJob()];
}
