import { describe, expect, it } from "vitest";
import { syncLine } from "./sync-status";

describe("syncLine", () => {
  it("shows nothing without a stored status", () => {
    expect(syncLine(null)).toBeNull();
  });

  it("keeps the last success for Time to print", () => {
    expect(syncLine({ lastSyncAt: "2026-10-14T10:05:33.000Z", lastSyncError: null })).toEqual({ error: null, lastSyncAt: "2026-10-14T10:05:33.000Z", failed: false });
  });

  it("shows the error with the last success", () => {
    expect(syncLine({ lastSyncAt: "2026-10-14T10:05:33.000Z", lastSyncError: "Unipile rejected the saved key. Connect again with a new key." })).toEqual({
      error: "Unipile rejected the saved key. Connect again with a new key.",
      lastSyncAt: "2026-10-14T10:05:33.000Z",
      failed: true,
    });
  });

  it("shows the error alone when no sync ever succeeded", () => {
    expect(syncLine({ lastSyncAt: null, lastSyncError: "Could not reach Unipile." })).toEqual({ error: "Could not reach Unipile.", lastSyncAt: null, failed: true });
  });

  it("has neither part before the first sync", () => {
    expect(syncLine({ lastSyncAt: null, lastSyncError: null })).toEqual({ error: null, lastSyncAt: null, failed: false });
  });
});
