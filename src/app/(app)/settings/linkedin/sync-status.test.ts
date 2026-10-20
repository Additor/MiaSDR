import { describe, expect, it } from "vitest";
import { syncLine } from "./sync-status";

describe("syncLine", () => {
  it("shows nothing without a stored status", () => {
    expect(syncLine(null, "UTC")).toBeNull();
  });

  it("prints the last success in UTC with the UTC original as the title", () => {
    expect(syncLine({ lastSyncAt: "2026-10-14T10:05:33.000Z", lastSyncError: null }, "UTC")).toEqual({
      text: "Last synced 2026-10-14 10:05.",
      failed: false,
      title: "2026-10-14 10:05 UTC",
    });
  });

  it("prints the last success in the organization zone and keeps UTC in the title", () => {
    expect(syncLine({ lastSyncAt: "2026-10-14T10:05:33.000Z", lastSyncError: null }, "America/New_York")).toEqual({
      text: "Last synced 2026-10-14 06:05.",
      failed: false,
      title: "2026-10-14 10:05 UTC",
    });
  });

  it("shows the error with the last success", () => {
    const line = syncLine({ lastSyncAt: "2026-10-14T10:05:33.000Z", lastSyncError: "Unipile rejected the saved key. Connect again with a new key." }, "UTC");
    expect(line).toEqual({
      text: "Unipile rejected the saved key. Connect again with a new key. Last synced 2026-10-14 10:05.",
      failed: true,
      title: "2026-10-14 10:05 UTC",
    });
  });

  it("shows the error alone when no sync ever succeeded", () => {
    expect(syncLine({ lastSyncAt: null, lastSyncError: "Could not reach Unipile." }, "UTC")).toEqual({ text: "Could not reach Unipile.", failed: true, title: undefined });
  });

  it("says no sync has run yet and when the next one comes", () => {
    expect(syncLine({ lastSyncAt: null, lastSyncError: null }, "UTC")).toEqual({ text: "Not synced yet. Accounts sync every hour.", failed: false });
  });
});
