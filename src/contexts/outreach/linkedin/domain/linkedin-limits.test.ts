import { describe, expect, it } from "vitest";
import { INVITE_LIMIT_RULE, MESSAGE_LIMIT_RULE, inviteLimitWarning, limitProblem, limitWarnings, messageBlock, messageLimitWarning } from "./linkedin-limits";

describe("limit bounds", () => {
  it.each([
    [INVITE_LIMIT_RULE, 0, true],
    [INVITE_LIMIT_RULE, 1, false],
    [INVITE_LIMIT_RULE, 100, false],
    [INVITE_LIMIT_RULE, 101, true],
    [INVITE_LIMIT_RULE, 12.5, true],
    [INVITE_LIMIT_RULE, "20", true],
    [INVITE_LIMIT_RULE, Number.NaN, true],
    [MESSAGE_LIMIT_RULE, 0, true],
    [MESSAGE_LIMIT_RULE, 200, false],
    [MESSAGE_LIMIT_RULE, 201, true],
  ])("%j %j -> problem %s", (rule, value, problem) => {
    expect(limitProblem(rule, value) !== null).toBe(problem);
  });
});

describe("limit warnings", () => {
  it("warns past the safe edge but not at it", () => {
    expect(inviteLimitWarning(30, true)).toBeNull();
    expect(inviteLimitWarning(31, true)).toMatch(/30 invitations/);
    expect(inviteLimitWarning(10, false)).toBeNull();
    expect(inviteLimitWarning(11, false)).toMatch(/free account/);
    expect(messageLimitWarning(100)).toBeNull();
    expect(messageLimitWarning(101)).toMatch(/100 messages/);
  });
  it("collects both", () => {
    expect(limitWarnings({ dailyInviteLimit: 50, dailyMessageLimit: 150, isPremium: true })).toHaveLength(2);
    expect(limitWarnings({ dailyInviteLimit: 5, dailyMessageLimit: 50, isPremium: false })).toEqual([]);
  });
});

describe("messageBlock", () => {
  it("blocks at the limit", () => {
    expect(messageBlock(49, 50)).toBeNull();
    expect(messageBlock(50, 50)).toBe("daily_limit");
  });
});
