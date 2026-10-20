import { describe, expect, it } from "vitest";
import { DEFAULT_UNKNOWN_SENDER_AI_DAILY_CAP, MAX_UNKNOWN_SENDER_AI_DAILY_CAP, readUnknownSenderAiCap, unknownSenderAiCapProblem } from "./ai-cap";

describe("unknown-sender AI cap", () => {
  it("defaults to 50 when the setting is missing or malformed", () => {
    expect(DEFAULT_UNKNOWN_SENDER_AI_DAILY_CAP).toBe(50);
    for (const raw of [undefined, null, "30", 1.5, -1, MAX_UNKNOWN_SENDER_AI_DAILY_CAP + 1, Number.NaN]) expect(readUnknownSenderAiCap(raw)).toBe(50);
  });
  it("reads a stored whole number, including 0", () => {
    expect(readUnknownSenderAiCap(0)).toBe(0);
    expect(readUnknownSenderAiCap(120)).toBe(120);
  });
  it("validates input", () => {
    expect(unknownSenderAiCapProblem(10)).toBeNull();
    expect(unknownSenderAiCapProblem(-1)).not.toBeNull();
    expect(unknownSenderAiCapProblem(2.5)).not.toBeNull();
    expect(unknownSenderAiCapProblem(MAX_UNKNOWN_SENDER_AI_DAILY_CAP + 1)).not.toBeNull();
  });
});
