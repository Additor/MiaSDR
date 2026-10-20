import { describe, expect, it } from "vitest";
import { capacityNote, capacityTier, runNowConfirmation, searchableLeft, formatCapacityReturn, nextCapacityReturn, nextSearchDayStart, searchCapacity } from "./linkedin-search-capacity";

const now = new Date("2026-10-14T10:00:00Z");
const today = "2026-10-14";
const base = { limit: 400, usedToday: 0, usedDay: today, limitReachedUntil: null, now };

describe("capacityTier", () => {
  it.each([
    [400, 400, "green"],
    [201, 400, "green"],
    [200, 400, "yellow"], // exactly half is not above half
    [51, 400, "yellow"],
    [50, 400, "yellow"], // exactly one eighth is not below one eighth
    [49, 400, "red"],
    [0, 400, "red"],
    [0, 0, "red"],
  ] as const)("%i of %i left is %s", (left, limit, tier) => {
    expect(capacityTier(left, limit)).toBe(tier);
  });
});

describe("searchCapacity", () => {
  it("counts a fresh account as fully available", () => {
    expect(searchCapacity(base)).toEqual({ limit: 400, used: 0, left: 400, tier: "green", restrictedUntil: null, returnsAt: null });
  });

  it("reads the counter of today only", () => {
    expect(searchCapacity({ ...base, usedToday: 399, usedDay: "2026-10-13" }).left).toBe(400);
    expect(searchCapacity({ ...base, usedToday: 399, usedDay: null }).left).toBe(400);
    expect(searchCapacity({ ...base, usedToday: 300 })).toMatchObject({ used: 300, left: 100, tier: "yellow", returnsAt: null });
  });

  it("returns at the next UTC midnight when the allowance is spent", () => {
    const result = searchCapacity({ ...base, usedToday: 400 });
    expect(result).toMatchObject({ left: 0, tier: "red" });
    expect(result.returnsAt?.toISOString()).toBe("2026-10-15T00:00:00.000Z");
  });

  it("never reports a negative remainder", () => {
    expect(searchCapacity({ ...base, usedToday: 450 }).left).toBe(0);
  });

  it("shows a restricted account as red with the return time even with allowance left", () => {
    const until = new Date("2026-10-14T18:00:00Z");
    const result = searchCapacity({ ...base, usedToday: 10, limitReachedUntil: until });
    expect(result).toMatchObject({ left: 390, tier: "red", restrictedUntil: until });
    expect(result.returnsAt).toEqual(until);
  });

  it("uses the later of the restriction and midnight when both apply", () => {
    const longer = new Date("2026-10-16T08:00:00Z");
    expect(searchCapacity({ ...base, usedToday: 400, limitReachedUntil: longer }).returnsAt).toEqual(longer);
    const shorter = new Date("2026-10-14T12:00:00Z");
    expect(searchCapacity({ ...base, usedToday: 400, limitReachedUntil: shorter }).returnsAt?.toISOString()).toBe("2026-10-15T00:00:00.000Z");
  });

  it("ignores a restriction that already ended", () => {
    expect(searchCapacity({ ...base, limitReachedUntil: new Date("2026-10-14T09:00:00Z") })).toMatchObject({ restrictedUntil: null, returnsAt: null, tier: "green" });
  });
});

describe("nextCapacityReturn", () => {
  const spent = (day: string) => ({ ...searchCapacity({ ...base, usedToday: 400 }), returnsAt: new Date(day) });
  it("is the earliest return when no account can search now", () => {
    expect(nextCapacityReturn([spent("2026-10-15T00:00:00Z"), spent("2026-10-14T20:00:00Z")])?.toISOString()).toBe("2026-10-14T20:00:00.000Z");
  });
  it("is null when one account can search, and without accounts", () => {
    expect(nextCapacityReturn([spent("2026-10-15T00:00:00Z"), searchCapacity(base)])).toBeNull();
    expect(nextCapacityReturn([])).toBeNull();
  });
});

describe("formatting", () => {
  it("prints a fixed UTC text", () => {
    expect(formatCapacityReturn(new Date("2026-10-15T00:00:00Z"))).toBe("Thu 15 Oct, 00:00 UTC");
  });
  it("rolls the month at midnight", () => {
    expect(nextSearchDayStart(new Date("2026-10-31T23:59:59Z")).toISOString()).toBe("2026-11-01T00:00:00.000Z");
  });
});

describe("capacityNote", () => {
  const reset = "2026-10-17 09:00 Asia/Seoul";
  it("says when an exhausted account resets and that new searches wait", () => {
    expect(capacityNote({ tier: "red", left: 0, restricted: false, resetsAt: reset })).toBe("Resets at 2026-10-17 09:00 Asia/Seoul. New searches wait until then.");
  });
  it("does not claim searches wait while the account still has people left", () => {
    expect(capacityNote({ tier: "red", left: 12, restricted: false, resetsAt: reset })).toBe("Resets at 2026-10-17 09:00 Asia/Seoul. After 12 more people, new searches wait until then.");
    expect(capacityNote({ tier: "red", left: 1, restricted: false, resetsAt: reset })).toContain("After 1 more person,");
  });
  it("stays quiet for green, yellow, restricted accounts and a missing time", () => {
    expect(capacityNote({ tier: "yellow", left: 40, restricted: false, resetsAt: reset })).toBeNull();
    expect(capacityNote({ tier: "green", left: 400, restricted: false, resetsAt: reset })).toBeNull();
    expect(capacityNote({ tier: "red", left: 0, restricted: true, resetsAt: reset })).toBeNull();
    expect(capacityNote({ tier: "red", left: 0, restricted: false, resetsAt: null })).toBeNull();
  });
});

describe("searchableLeft", () => {
  it("adds what unrestricted accounts have left and counts a restricted account as 0", () => {
    expect(searchableLeft([{ left: 100, restrictedUntil: null }, { left: 50, restrictedUntil: new Date() }, { left: 25, restrictedUntil: null }])).toBe(125);
    expect(searchableLeft([])).toBe(0);
  });
});

describe("runNowConfirmation", () => {
  const resetsAt = "2026-10-17 09:00 Asia/Seoul";
  it("states the capacity the run may use and what stays untouched", () => {
    const { title, description } = runNowConfirmation({ due: 3, left: 180, accounts: 2, resetsAt });
    expect(title).toBe("Run 3 searches now?");
    expect(description).toContain("up to 180 more people today across 2 accounts");
    expect(description).toContain("count resets at 2026-10-17 09:00 Asia/Seoul");
    expect(description).toContain("Running, finished and failed searches, and people already in Leads, stay as they are.");
  });
  it("uses singular forms", () => {
    const { title, description } = runNowConfirmation({ due: 1, left: 1, accounts: 1, resetsAt });
    expect(title).toBe("Run 1 search now?");
    expect(description).toContain("1 more person today across 1 account.");
  });
  it("says so when no capacity is left", () => {
    expect(runNowConfirmation({ due: 2, left: 0, accounts: 1, resetsAt }).description).toContain("No account has search capacity left today, so they start when it returns at 2026-10-17 09:00 Asia/Seoul.");
  });
});
