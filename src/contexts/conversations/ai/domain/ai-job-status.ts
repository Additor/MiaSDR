/** AI job statuses. The `ai_jobs_status_ck` check in the schema is built from this list. */
export const AI_JOB_STATUSES = ["queued", "running", "succeeded", "failed", "skipped"] as const;
export type AiJobStatus = (typeof AI_JOB_STATUSES)[number];
