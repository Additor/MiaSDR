import { backfillLinkedinUrls } from "@/contexts/people/infrastructure/backfill-linkedin-urls";
import type { RolloverStep } from "@/platform/jobs/rollover";

/**
 * The composition point for daily rollover steps, beside job-registry.ts for jobs. Platform's
 * rollover job runs them. A context adds its step here when it holds state that must change once
 * per organization day. Steps must be idempotent.
 *
 * The only step is a safety net for people.linkedin_url. Every per-day figure is derived from time, so no step resets a counter:
 * - Email daily limit: counts today's `sends` rows since the start of the local
 *   day (`startOfLocalDay` in drizzle-outreach-store).
 * - LinkedIn daily and weekly invitation counts: also `sends` rows in a window.
 * - LinkedIn `limit_reached_until`: a timestamp, compared with now when read.
 * - LinkedIn search `search_leads_today`: keyed by `search_day` (UTC), a claim on
 *   a later day restarts the count. A rollover reset in the organization's zone
 *   would restart it mid UTC day and double the budget, so none is registered.
 */
export function rolloverSteps(): RolloverStep[] {
  return [
    {
      // Idempotent: only rows with a slug and no URL change, so a rerun updates nothing.
      name: "backfill-linkedin-urls",
      async run({ organizationId }) {
        await backfillLinkedinUrls(organizationId);
      },
    },
  ];
}
