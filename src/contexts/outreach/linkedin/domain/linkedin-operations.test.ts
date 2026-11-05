import { describe, expect, it } from "vitest";
import { OPERATION_GONE_HOURS, OPERATION_TIMEOUT_MINUTES, allowanceCutNote, asyncSearchLimit, nextOperationStep } from "./linkedin-operations";

const now = new Date("2026-11-05T12:00:00Z");
const ago = (minutes: number) => new Date(now.getTime() - minutes * 60_000);

describe("what the settle job does with an action that has not finished", () => {
  const live = { now, subjectLive: true };

  it("leaves one that is waiting within the limit", () => {
    expect(nextOperationStep({ ...live, submittedAt: ago(5), read: { held: false } })).toBe("wait");
    expect(nextOperationStep({ ...live, submittedAt: ago(OPERATION_TIMEOUT_MINUTES - 1), read: { held: false } })).toBe("wait");
  });

  it("stops one that ran too long", () => {
    expect(nextOperationStep({ ...live, submittedAt: ago(OPERATION_TIMEOUT_MINUTES), read: { held: false } })).toBe("cancel_timeout");
  });

  it("stops one held for working hours, at once", () => {
    expect(nextOperationStep({ ...live, submittedAt: ago(1), read: { held: true } })).toBe("cancel_held");
  });

  it("stops one nobody wants any more, before any other reason", () => {
    expect(nextOperationStep({ now, subjectLive: false, submittedAt: ago(1), read: { held: true } })).toBe("cancel_stopped");
  });

  // A failed read says nothing about the send. Reading it as a refusal is how a message goes out twice.
  it.each([1, OPERATION_TIMEOUT_MINUTES, OPERATION_GONE_HOURS * 60 - 1])("does nothing on a failed read after %i minutes", (minutes) => {
    expect(nextOperationStep({ ...live, submittedAt: ago(minutes), read: null })).toBe("wait");
    expect(nextOperationStep({ now, subjectLive: false, submittedAt: ago(minutes), read: null })).toBe("wait");
  });

  it("closes one the vendor has not answered about for a day", () => {
    expect(nextOperationStep({ ...live, submittedAt: ago(OPERATION_GONE_HOURS * 60), read: null })).toBe("give_up");
  });
});

describe("a search read in one action", () => {
  it("asks for what the search still wants, within the allowance", () => {
    expect(asyncSearchLimit({ maxResults: 100, found: 40, quotaLeft: 400 })).toBe(60);
    expect(asyncSearchLimit({ maxResults: 2500, found: 0, quotaLeft: 400 })).toBe(400);
    expect(asyncSearchLimit({ maxResults: 10, found: 10, quotaLeft: 400 })).toBe(0);
  });

  it("says so when the allowance cut the read", () => {
    expect(allowanceCutNote({ wanted: 2500, limit: 400, received: 400 })).toContain("Read 400 people");
  });

  it("says nothing when the search ended by itself or the read was not cut", () => {
    expect(allowanceCutNote({ wanted: 2500, limit: 400, received: 120 })).toBeNull();
    expect(allowanceCutNote({ wanted: 100, limit: 100, received: 100 })).toBeNull();
  });
});
