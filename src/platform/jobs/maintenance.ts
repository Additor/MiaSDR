import { createHistoryPruneJob } from "./prune";
import { createDailyRolloverJob, type OrganizationZones, type RolloverStep } from "./rollover";
import type { Job } from "./types";

/**
 * Platform jobs that belong to no bounded context: daily rollover and history pruning. src/composition passes the rollover
 * steps and tenancy's organization zones.
 */
export function maintenanceJobs(rollover: { steps: readonly RolloverStep[]; zones: OrganizationZones }): Job[] {
  return [createDailyRolloverJob(rollover.steps, rollover.zones), createHistoryPruneJob()];
}
