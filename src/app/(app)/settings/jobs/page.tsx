import type { Metadata } from "next";
import { connection } from "next/server";
import { Suspense } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { requireOrgContext } from "@/contexts/identity/infrastructure/session";
import { getLinkedInJobsOverview } from "@/contexts/outreach/linkedin/application/linkedin-operations";
import { linkedinOperations } from "@/composition/inbox-filing";
import { isOwnerOrAdmin } from "@/contexts/tenancy/domain/roles";
import { toActor } from "@/app/_lib/api";
import { getFailedAiJobs, getSkippedAiJobs } from "@/contexts/conversations/ai/application/ai-job-ops";
import { aiJobOpsDeps } from "@/contexts/conversations/ai/infrastructure/ai-composition";
import { recentTickFailures } from "@/platform/jobs/failure-log";
import { AiJobsPanel } from "./ai-jobs-panel";
import { Tabs } from "@/components/shell/tabs";
import { JobsHistory, LinkedInOperations } from "./jobs-panel";
import { AdminNotice } from "../admin-notice";

export const metadata: Metadata = { title: "Jobs" };

export default function JobsPage() {
  return (
    <div className="max-w-5xl">
      <Suspense fallback={<Skeleton className="h-64 w-full max-w-5xl" />}>
        <Jobs />
      </Suspense>
    </div>
  );
}

async function Jobs() {
  await connection();
  const ctx = await requireOrgContext();
  if (!isOwnerOrAdmin(ctx.role)) return <AdminNotice action="see jobs" replacesPage />;
  const actor = toActor(ctx);
  const [overview, failedAi, skippedAi, tickFailures] = await Promise.all([
    getLinkedInJobsOverview(linkedinOperations(), actor),
    getFailedAiJobs(aiJobOpsDeps(), actor),
    getSkippedAiJobs(aiJobOpsDeps(), actor),
    recentTickFailures(20),
  ]);
  const linkedin = JSON.parse(JSON.stringify(overview));
  return (
    <div className="stack-section max-w-5xl">
      <Tabs
        label="Jobs"
        tabs={[
          {
            id: "attention",
            label: "Needs attention",
            count: failedAi.total + tickFailures.length,
            content: (
              <>
                <AiJobsPanel failed={JSON.parse(JSON.stringify(failedAi))} skipped={JSON.parse(JSON.stringify(skippedAi))} tickFailures={JSON.parse(JSON.stringify(tickFailures))} />
                <LinkedInOperations overview={linkedin} />
              </>
            ),
          },
          { id: "history", label: "History", content: <JobsHistory overview={linkedin} /> },
        ]}
      />
    </div>
  );
}
