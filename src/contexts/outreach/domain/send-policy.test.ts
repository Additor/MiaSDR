import { describe, expect, it } from "vitest";
import { dueAfterDays, emailRules, mailboxBlock, pickGapMinutes, retryDelayMinutes, sendGapProblem, type MailboxState } from "./send-policy";
import { defaultWorkingHours } from "./working-hours";

const now = new Date("2026-10-14T01:00:00Z"); // Wed 10:00 Seoul
const base: MailboxState = {
  status: "connected",
  nextSendAt: null,
  dailySendLimit: 30,
  sentToday: 0,
  workingHours: defaultWorkingHours("Asia/Seoul"),
};

describe("mailboxBlock", () => {
  it("allows a connected mailbox inside hours with room", () => {
    expect(mailboxBlock(now, base)).toBeNull();
  });
  it("blocks in a fixed priority", () => {
    expect(mailboxBlock(now, { ...base, status: "failed" })).toBe("not_connected");
    expect(mailboxBlock(now, { ...base, nextSendAt: new Date(now.getTime() + 60_000) })).toBe("throttled");
    expect(mailboxBlock(new Date("2026-10-14T14:00:00Z"), base)).toBe("outside_hours");
    expect(mailboxBlock(now, { ...base, sentToday: 30 })).toBe("daily_limit");
  });
  it("allows a send exactly when the gap ends", () => {
    expect(mailboxBlock(now, { ...base, nextSendAt: now })).toBeNull();
  });
});

describe("emailRules", () => {
  it("defaults to 18 to 24 minutes", () => {
    expect(emailRules(null).sendGapMinutes).toEqual([18, 24]);
  });
  it("accepts a valid range and rejects out-of-bound or reversed ones", () => {
    expect(emailRules({ sendGapMinutes: [5, 10] }).sendGapMinutes).toEqual([5, 10]);
    expect(emailRules({ sendGapMinutes: [0, 10] }).sendGapMinutes).toEqual([18, 24]);
    expect(emailRules({ sendGapMinutes: [10, 300] }).sendGapMinutes).toEqual([18, 24]);
    expect(emailRules({ sendGapMinutes: [20, 10] }).sendGapMinutes).toEqual([18, 24]);
    expect(emailRules({ sendGapMinutes: "soon" }).sendGapMinutes).toEqual([18, 24]);
  });
});

describe("pickGapMinutes", () => {
  it("is inclusive of both ends", () => {
    expect(pickGapMinutes([18, 24], () => 0)).toBe(18);
    expect(pickGapMinutes([18, 24], () => 0.999999)).toBe(24);
  });
});

describe("retry and due times", () => {
  it("backs off linearly", () => {
    expect(retryDelayMinutes(1)).toBe(15);
    expect(retryDelayMinutes(2)).toBe(30);
  });
  it("adds whole days", () => {
    expect(dueAfterDays(new Date("2026-10-14T00:00:00Z"), 3).toISOString()).toBe("2026-10-17T00:00:00.000Z");
  });
});

describe("sendGapProblem", () => {
  it("accepts whole minutes from 1 to 240 with min <= max", () => {
    expect(sendGapProblem(1, 1)).toBeNull();
    expect(sendGapProblem(18, 24)).toBeNull();
    expect(sendGapProblem(240, 240)).toBeNull();
  });
  it("rejects out-of-range, reversed and non-integer values", () => {
    expect(sendGapProblem(0, 10)).toMatch(/between 1 and 240/);
    expect(sendGapProblem(10, 241)).toMatch(/between 1 and 240/);
    expect(sendGapProblem(30, 20)).toMatch(/cannot be longer/);
    expect(sendGapProblem(1.5, 10)).toMatch(/whole number/);
    expect(sendGapProblem("5", 10)).toMatch(/whole number/);
    expect(sendGapProblem(Number.NaN, 10)).toMatch(/whole number/);
  });
});
