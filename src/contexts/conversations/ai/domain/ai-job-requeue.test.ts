import { describe, expect, it } from "vitest";
import { AUTO_REQUEUE_BASE_SECONDS, AUTO_REQUEUE_CEILING, AUTO_REQUEUE_MAX_SECONDS, autoRequeueDelaySeconds, isRequeueableSkip, nextAutoRequeueAt } from "./ai-job-requeue";

const failedAt = new Date("2026-10-15T10:00:00Z");

describe("autoRequeueDelaySeconds", () => {
  it("doubles with each requeue and stops at the cap", () => {
    expect(autoRequeueDelaySeconds(0)).toBe(AUTO_REQUEUE_BASE_SECONDS);
    expect(autoRequeueDelaySeconds(1)).toBe(AUTO_REQUEUE_BASE_SECONDS * 2);
    expect(autoRequeueDelaySeconds(2)).toBe(AUTO_REQUEUE_BASE_SECONDS * 4);
    expect(autoRequeueDelaySeconds(20)).toBe(AUTO_REQUEUE_MAX_SECONDS);
  });
});

describe("nextAutoRequeueAt", () => {
  it("waits the backoff after the failure", () => {
    const at = nextAutoRequeueAt({ failureKind: "transient", autoRequeues: 1, requeueCeiling: null, failedAt });
    expect(at?.getTime()).toBe(failedAt.getTime() + AUTO_REQUEUE_BASE_SECONDS * 2 * 1000);
  });

  it("treats a job with no recorded kind as transient and a lease loss as retryable", () => {
    expect(nextAutoRequeueAt({ failureKind: null, autoRequeues: 0, requeueCeiling: null, failedAt })).not.toBeNull();
    expect(nextAutoRequeueAt({ failureKind: "lease", autoRequeues: 0, requeueCeiling: null, failedAt })).not.toBeNull();
  });

  it("never requeues permanent or wrong-shape failures", () => {
    expect(nextAutoRequeueAt({ failureKind: "permanent", autoRequeues: 0, requeueCeiling: null, failedAt })).toBeNull();
    expect(nextAutoRequeueAt({ failureKind: "shape", autoRequeues: 0, requeueCeiling: null, failedAt })).toBeNull();
  });

  it("stops at the ceiling stored on the job, or the default", () => {
    expect(nextAutoRequeueAt({ failureKind: "transient", autoRequeues: 2, requeueCeiling: 2, failedAt })).toBeNull();
    expect(nextAutoRequeueAt({ failureKind: "transient", autoRequeues: 1, requeueCeiling: 2, failedAt })).not.toBeNull();
    expect(nextAutoRequeueAt({ failureKind: "transient", autoRequeues: AUTO_REQUEUE_CEILING, requeueCeiling: null, failedAt })).toBeNull();
  });

  it("requeues only a skipped job with a known skip reason", () => {
    expect(isRequeueableSkip({ status: "skipped", skipReason: "daily_cap" })).toBe(true);
    expect(isRequeueableSkip({ status: "skipped", skipReason: "other" })).toBe(false);
    expect(isRequeueableSkip({ status: "skipped", skipReason: null })).toBe(false);
    expect(isRequeueableSkip({ status: "failed", skipReason: "daily_cap" })).toBe(false);
  });
});
