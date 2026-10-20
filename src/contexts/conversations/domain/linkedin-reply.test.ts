import { describe, expect, it } from "vitest";
import { MAX_LINKEDIN_REPLY, checkReplyText, replyBlock, replyGapSeconds, utcDayStart } from "./linkedin-reply";

const now = new Date("2026-10-15T12:00:00Z");
const ok = { status: "connected", limitReachedUntil: null, dailyMessageLimit: 50 };

describe("checkReplyText", () => {
  it("trims and normalizes line endings", () => {
    expect(checkReplyText("  hi\r\nthere \n")).toEqual({ ok: true, text: "hi\nthere" });
  });
  it("rejects empty and oversized text", () => {
    expect(checkReplyText("  \n ")).toMatchObject({ ok: false });
    expect(checkReplyText("x".repeat(MAX_LINKEDIN_REPLY))).toMatchObject({ ok: true });
    expect(checkReplyText("x".repeat(MAX_LINKEDIN_REPLY + 1))).toMatchObject({ ok: false });
  });
});

describe("replyGapSeconds", () => {
  it("uses the default for missing and out-of-bound values", () => {
    expect(replyGapSeconds(null)).toBe(8);
    expect(replyGapSeconds({ replyGapSeconds: -1 })).toBe(8);
    expect(replyGapSeconds({ replyGapSeconds: null })).toBe(8);
    expect(replyGapSeconds({ replyGapSeconds: "5" })).toBe(8);
    expect(replyGapSeconds({ replyGapSeconds: 0 })).toBe(0);
    expect(replyGapSeconds({ replyGapSeconds: 601 })).toBe(8);
    expect(replyGapSeconds({ replyGapSeconds: 2.5 })).toBe(8);
    expect(replyGapSeconds({ replyGapSeconds: 30 })).toBe(30);
  });
});

describe("replyBlock", () => {
  const free = { usedToday: 0, lastAttemptAt: null, gapSeconds: 8 };
  it("allows a connected account under its caps, at any hour", () => {
    expect(replyBlock(new Date("2026-10-15T03:00:00Z"), ok, free)).toBeNull();
  });
  it("blocks a disconnected account", () => {
    expect(replyBlock(now, { ...ok, status: "disconnected" }, free)).toMatchObject({ reason: "not_connected" });
  });
  it("blocks while the account is paused and releases at the pause end", () => {
    const until = new Date("2026-10-15T12:00:01Z");
    expect(replyBlock(now, { ...ok, limitReachedUntil: until }, free)).toMatchObject({ reason: "paused" });
    expect(replyBlock(new Date(until), { ...ok, limitReachedUntil: until }, free)).toBeNull();
  });
  it("blocks at the daily cap, not below it", () => {
    expect(replyBlock(now, ok, { ...free, usedToday: 49 })).toBeNull();
    expect(replyBlock(now, ok, { ...free, usedToday: 50 })).toMatchObject({ reason: "daily_cap" });
  });
  it("blocks inside the gap and reports the wait", () => {
    const last = new Date(now.getTime() - 3000);
    expect(replyBlock(now, ok, { ...free, lastAttemptAt: last })).toMatchObject({ reason: "too_fast", retryAfterSeconds: 5 });
    expect(replyBlock(now, ok, { ...free, lastAttemptAt: new Date(now.getTime() - 8000) })).toBeNull();
  });
});

describe("utcDayStart", () => {
  it("returns midnight UTC", () => {
    expect(utcDayStart(new Date("2026-10-15T23:59:59Z")).toISOString()).toBe("2026-10-15T00:00:00.000Z");
  });
});
