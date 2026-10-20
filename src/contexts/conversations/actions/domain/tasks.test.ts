import { describe, expect, it } from "vitest";
import { ValidationError } from "@/shared/errors";
import { canChangeNote, canChangeTask, compareTasks, dayInZone, endOfDayInZone, parseTaskInput } from "./tasks";

describe("endOfDayInZone", () => {
  it("is the last second of the local day", () => {
    expect(endOfDayInZone("2026-10-15", "UTC").toISOString()).toBe("2026-10-15T23:59:59.000Z");
    expect(endOfDayInZone("2026-10-15", "Asia/Seoul").toISOString()).toBe("2026-10-15T14:59:59.000Z");
    expect(endOfDayInZone("2026-10-15", "America/Los_Angeles").toISOString()).toBe("2026-10-16T06:59:59.000Z");
  });
  it("follows the daylight-saving offset of that day", () => {
    expect(endOfDayInZone("2026-03-08", "America/New_York").toISOString()).toBe("2026-03-09T03:59:59.000Z");
    expect(endOfDayInZone("2026-03-07", "America/New_York").toISOString()).toBe("2026-03-08T04:59:59.000Z");
  });
  it("rejects impossible days and unknown zones", () => {
    expect(() => endOfDayInZone("2026-02-30", "UTC")).toThrow(ValidationError);
    expect(() => endOfDayInZone("tomorrow", "UTC")).toThrow(ValidationError);
    expect(() => endOfDayInZone("2026-10-15", "Mars/Base")).toThrow(ValidationError);
  });
  it("round-trips with dayInZone", () => {
    expect(dayInZone(endOfDayInZone("2026-10-15", "Asia/Seoul"), "Asia/Seoul")).toBe("2026-10-15");
  });
});

describe("parseTaskInput", () => {
  it("stores the current IANA name for a legacy zone", () => {
    expect(parseTaskInput({ name: "Call", dueDay: "2026-10-20", timeZone: "Asia/Calcutta" }).timeZone).toBe("Asia/Kolkata");
  });

  it("trims and validates", () => {
    expect(parseTaskInput({ name: "  Call  ", dueDay: "2026-10-20" })).toMatchObject({ name: "Call", dueDay: "2026-10-20", timeZone: "UTC", description: null });
    expect(() => parseTaskInput({ name: "  " })).toThrow(ValidationError);
    expect(() => parseTaskInput({ name: "x".repeat(201) })).toThrow(ValidationError);
    expect(() => parseTaskInput({ name: "a", dueDay: "2026-13-01" })).toThrow(ValidationError);
  });
});

describe("permissions", () => {
  const me = { userId: "u1", role: "member" };
  it("lets a member change their own or assigned task, an admin any", () => {
    expect(canChangeTask(me, false, { createdBy: "u1", assigneeId: null })).toBe(true);
    expect(canChangeTask(me, false, { createdBy: "u2", assigneeId: "u1" })).toBe(true);
    expect(canChangeTask(me, false, { createdBy: "u2", assigneeId: "u3" })).toBe(false);
    expect(canChangeTask(me, true, { createdBy: "u2", assigneeId: null })).toBe(true);
  });
  it("lets a member change only their own note", () => {
    expect(canChangeNote(me, false, { createdBy: "u1" })).toBe(true);
    expect(canChangeNote(me, false, { createdBy: "u2" })).toBe(false);
    expect(canChangeNote(me, false, { createdBy: null })).toBe(false);
    expect(canChangeNote(me, true, { createdBy: null })).toBe(true);
  });
});

describe("compareTasks", () => {
  const t = (isCompleted: boolean, due: string | null, created = "2026-01-01") => ({ isCompleted, dueAt: due ? new Date(due) : null, createdAt: new Date(created) });
  it("orders overdue first, no date next, completed last", () => {
    const list = [t(true, "2026-01-01"), t(false, null), t(false, "2026-10-20"), t(false, "2026-10-10")];
    list.sort(compareTasks);
    expect(list.map((x) => [x.isCompleted, x.dueAt?.toISOString().slice(0, 10) ?? null])).toEqual([
      [false, "2026-10-10"],
      [false, "2026-10-20"],
      [false, null],
      [true, "2026-01-01"],
    ]);
  });
});
