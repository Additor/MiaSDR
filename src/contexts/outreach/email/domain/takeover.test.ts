import { describe, expect, it } from "vitest";
import { canTakeOver, takeoverCutoff } from "./takeover";
import { emailRules, takeoverHoursProblem } from "../../domain/send-policy";
import { resolveThreading } from "./threading";

const now = new Date("2026-03-10T12:00:00Z");
const hoursAgo = (h: number) => new Date(now.getTime() - h * 3_600_000);

describe("canTakeOver", () => {
  it("waits for the delay after the mailbox became unavailable", () => {
    const due = hoursAgo(48);
    expect(canTakeOver(now, 24, { status: "disabled", unavailableSince: hoursAgo(23) }, due)).toBe(false);
    expect(canTakeOver(now, 24, { status: "disabled", unavailableSince: hoursAgo(24) }, due)).toBe(true);
    expect(canTakeOver(now, 24, { status: "failed", unavailableSince: hoursAgo(30) }, due)).toBe(true);
  });

  it("never fires for a connected mailbox, however overdue the follow-up", () => {
    expect(canTakeOver(now, 24, { status: "connected", unavailableSince: null }, hoursAgo(500))).toBe(false);
  });

  it("uses the due time when the unable period was not recorded or the row is gone", () => {
    expect(canTakeOver(now, 24, { status: "disabled", unavailableSince: null }, hoursAgo(25))).toBe(true);
    expect(canTakeOver(now, 24, { status: null, unavailableSince: null }, hoursAgo(10))).toBe(false);
    expect(canTakeOver(now, 24, { status: null, unavailableSince: null }, hoursAgo(25))).toBe(true);
  });

  it("honors a custom delay", () => {
    expect(canTakeOver(now, 1, { status: "disabled", unavailableSince: hoursAgo(2) }, hoursAgo(5))).toBe(true);
    expect(takeoverCutoff(now, 2).toISOString()).toBe("2026-03-10T10:00:00.000Z");
  });
});

describe("takeover delay setting", () => {
  it("validates whole hours from 1 to 168", () => {
    expect(takeoverHoursProblem(1)).toBeNull();
    expect(takeoverHoursProblem(168)).toBeNull();
    expect(takeoverHoursProblem(0)).not.toBeNull();
    expect(takeoverHoursProblem(169)).not.toBeNull();
    expect(takeoverHoursProblem(1.5)).not.toBeNull();
    expect(takeoverHoursProblem("24")).not.toBeNull();
  });

  it("defaults to 24 and ignores invalid stored values", () => {
    expect(emailRules(null).takeoverAfterHours).toBe(24);
    expect(emailRules({ takeoverAfterHours: 48 }).takeoverAfterHours).toBe(48);
    expect(emailRules({ takeoverAfterHours: 999 }).takeoverAfterHours).toBe(24);
    expect(emailRules({ sendGapMinutes: [5, 9], takeoverAfterHours: 6 })).toEqual({ sendGapMinutes: [5, 9], takeoverAfterHours: 6 });
  });
});

describe("threading after a takeover", () => {
  it("keeps the subject but drops thread fields when earlier sends belong to another mailbox", () => {
    const t = resolveThreading("", [{ subject: "Hello", rfcMessageId: null, threadId: null }]);
    expect(t).toEqual({ subject: "Re: Hello", inReplyTo: null, references: [], threadId: null });
  });
});
