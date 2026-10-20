import { describe, expect, it } from "vitest";
import {
  canApply,
  clampMaxResults,
  describeSearch,
  itemsToKeep,
  normalizeSearchUrl,
  resultSlug,
  searchActions,
  batchRowActions,
  hasActiveSearch,
  isActiveStatus,
  searchDay,
  searchNotice,
  searchStatusLabel,
  searchQuotaLeft,
  searchRetrySeconds,
  statusAfter,
} from "./linkedin-search";

const ok = (input: string) => {
  const r = normalizeSearchUrl(input);
  if (!r.ok) throw new Error(r.reason);
  return r.value;
};

describe("normalizeSearchUrl", () => {
  it("accepts a classic people search and drops tracking parameters", () => {
    const v = ok("https://www.linkedin.com/search/results/people/?keywords=cto&origin=GLOBAL_SEARCH_HEADER&sid=abc&geoUrn=%5B%22103644278%22%5D");
    expect(v.variant).toBe("classic");
    expect(v.url).toBe("https://www.linkedin.com/search/results/people/?keywords=cto&geoUrn=%5B%22103644278%22%5D");
  });

  it("accepts a Sales Navigator people search and keeps its query", () => {
    const v = ok("linkedin.com/sales/search/people?query=(filters:List())&sessionId=xyz&viewAllFilters=true");
    expect(v.variant).toBe("sales_navigator");
    expect(v.url.startsWith("https://www.linkedin.com/sales/search/people?")).toBe(true);
    expect(v.url).not.toContain("sessionId");
    expect(v.url).toContain("viewAllFilters=true");
  });

  it("treats a trailing slash and host case the same", () => {
    expect(ok("HTTPS://WWW.LINKEDIN.COM/sales/search/people/").url).toBe("https://www.linkedin.com/sales/search/people");
  });

  it("refuses other hosts, profiles, company searches and junk with a reason", () => {
    for (const bad of ["", "not a url", "https://example.com/search/results/people/", "https://www.linkedin.com/in/jane-doe", "https://www.linkedin.com/search/results/companies/?keywords=x", "https://evil.com/?u=linkedin.com/search/results/people/"]) {
      expect(normalizeSearchUrl(bad)).toMatchObject({ ok: false });
    }
    expect(normalizeSearchUrl("a".repeat(4001))).toMatchObject({ ok: false });
  });
});

describe("limits and transitions", () => {
  it("clamps the result cap to a whole number from 1 to 2500", () => {
    expect(clampMaxResults(undefined)).toBe(100);
    expect(clampMaxResults(2500)).toBe(2500);
    expect(clampMaxResults(0)).toBeNull();
    expect(clampMaxResults(2501)).toBeNull();
    expect(clampMaxResults(1.5)).toBeNull();
  });

  it("keeps only what fits under the cap", () => {
    expect(itemsToKeep({ pageSize: 10, maxResults: 25, alreadyFound: 20 })).toBe(5);
    expect(itemsToKeep({ pageSize: 10, maxResults: 25, alreadyFound: 30 })).toBe(0);
  });

  it("computes the allowance and the UTC day key", () => {
    expect(searchQuotaLeft({ limit: 400, usedToday: 395 })).toBe(5);
    expect(searchQuotaLeft({ limit: 400, usedToday: 900 })).toBe(0);
    expect(searchDay(new Date("2026-10-14T23:59:59Z"))).toBe("2026-10-14");
  });

  it("backs off from one minute, doubling, up to fifteen", () => {
    expect([1, 2, 3, 4, 5, 6].map(searchRetrySeconds)).toEqual([60, 120, 240, 480, 900, 900]);
  });

  it("allows pause, resume and cancel only from the right states", () => {
    expect(canApply("running", "pause")).toBe(true);
    expect(canApply("paused", "pause")).toBe(false);
    expect(canApply("paused", "resume")).toBe(true);
    expect(canApply("failed", "resume")).toBe(true);
    expect(canApply("completed", "resume")).toBe(false);
    expect(canApply("completed", "cancel")).toBe(false);
    expect(canApply("cancelled", "cancel")).toBe(false);
    expect(canApply("paused_limit", "cancel")).toBe(true);
    expect(statusAfter("resume")).toBe("queued");
  });

  it("describes every status", () => {
    for (const status of ["queued", "running", "paused", "paused_limit", "completed", "failed", "cancelled"] as const) {
      expect(describeSearch({ status, found: 3, maxResults: 10, pagesFetched: 1 }).label).not.toBe("");
    }
  });

  it("says when capacity returns for a search waiting on the limit", () => {
    const waiting = { status: "paused_limit", found: 3, maxResults: 10, pagesFetched: 1 } as const;
    expect(describeSearch({ ...waiting, capacityReturns: "Thu 15 Oct, 00:00 UTC" }).detail).toContain("Thu 15 Oct, 00:00 UTC");
    expect(describeSearch(waiting).detail).not.toContain("tomorrow");
    expect(describeSearch({ ...waiting, status: "queued", capacityReturns: "x" }).detail).not.toContain("x");
  });
});

describe("resultSlug", () => {
  it("reads the slug from a profile URL or a bare public identifier", () => {
    expect(resultSlug({ identifier: "x", profileUrl: "https://www.linkedin.com/in/Jane-Doe-4a1/?miniProfileUrn=1" })).toBe("jane-doe-4a1");
    expect(resultSlug({ identifier: "jane-doe", profileUrl: null })).toBe("jane-doe");
    expect(resultSlug({ identifier: "https://www.linkedin.com/in/jane-doe", profileUrl: null })).toBe("jane-doe");
  });
  it("refuses member ids and Sales Navigator links", () => {
    expect(resultSlug({ identifier: "ACwAAAopaque1xxxxxxxxxxxxxxxxxxxxxxx", profileUrl: null })).toBeNull();
    // A classic result links to /in/<member id> when there is no public slug. Lowercasing it would corrupt the id.
    expect(resultSlug({ identifier: "ACoAAB1234567890abcdefghij", profileUrl: "https://www.linkedin.com/in/ACoAAB1234567890abcdefghij" })).toBeNull();
    expect(resultSlug({ identifier: "ACoAAB1234567890abcdefghij", profileUrl: "https://www.linkedin.com/sales/lead/ACoAAB1234567890abcdefghij,NAME_SEARCH" })).toBeNull();
  });
});

describe("searchActions", () => {
  const offered = (status: Parameters<typeof searchActions>[0]) => searchActions(status).map((a) => a.action);
  const statuses = ["queued", "running", "paused", "paused_limit", "completed", "failed", "cancelled"] as const;

  it("offers pause and cancel to a search that is working or waiting", () => {
    expect(offered("queued")).toEqual(["pause", "cancel"]);
    expect(offered("running")).toEqual(["pause", "cancel"]);
  });
  it("offers resume and stop to a paused search, and retry only to a failed one", () => {
    expect(offered("paused")).toEqual(["resume", "cancel"]);
    expect(offered("failed")).toEqual(["resume"]);
    expect(searchActions("failed")[0].label).toBe("Retry");
    expect(searchActions("paused")[0].label).toBe("Resume");
  });
  it("offers a search waiting for the limit pause and cancel, never both pause and resume", () => {
    expect(offered("paused_limit")).toEqual(["pause", "cancel"]);
  });
  it("offers nothing once a search is done or cancelled", () => {
    expect(offered("completed")).toEqual([]);
    expect(offered("cancelled")).toEqual([]);
  });
  it("only offers actions the server accepts for that status", () => {
    for (const status of statuses) for (const { action } of searchActions(status)) expect(canApply(status, action)).toBe(true);
  });
});

describe("searchStatusLabel and searchNotice", () => {
  it("names the real status instead of calling a limit wait paused", () => {
    expect(searchStatusLabel("paused_limit")).toBe("waiting for limit");
    expect(searchStatusLabel("paused")).toBe("paused");
    expect(searchStatusLabel("running")).toBe("running");
  });
  it("drops the stored copy of the limit sentence, so the explanation shows once", () => {
    const stored = "Every connected account has used its daily search allowance.";
    expect(searchNotice({ status: "paused_limit", lastError: stored })).toBeNull();
    expect(searchNotice({ status: "failed", lastError: "Profile not found" })).toBe("Profile not found");
    expect(searchNotice({ status: "queued", lastError: "LinkedIn limited this account." })).toBe("LinkedIn limited this account.");
    expect(searchNotice({ status: "queued", lastError: null })).toBeNull();
  });
});

describe("batchRowActions", () => {
  const statuses = ["queued", "running", "paused", "paused_limit", "completed", "failed", "cancelled"] as const;
  const ids = (list: Array<{ id: string }>) => list.map((a) => a.id);

  it("shows one or two buttons for the status and keeps the rest in the menu", () => {
    expect(ids(batchRowActions("queued", { canRemove: true }).buttons)).toEqual(["run", "pause"]);
    expect(ids(batchRowActions("running", { canRemove: true }).buttons)).toEqual(["pause"]);
    expect(ids(batchRowActions("paused", { canRemove: true }).buttons)).toEqual(["run"]);
    expect(ids(batchRowActions("paused", { canRemove: true }).menu)).toEqual(["resume", "cancel", "remove"]);
    for (const status of statuses) expect(batchRowActions(status, { canRemove: true }).buttons.length).toBeLessThanOrEqual(2);
  });
  it("never offers Stop on a failed row, and offers Rerun", () => {
    const failed = batchRowActions("failed", { canRemove: true });
    expect(ids(failed.buttons)).toEqual(["rerun"]);
    expect(ids([...failed.buttons, ...failed.menu])).not.toContain("cancel");
  });
  it("does not offer Run to a search waiting for the daily limit, which Run cannot beat", () => {
    const waiting = batchRowActions("paused_limit", { canRemove: false });
    expect(ids([...waiting.buttons, ...waiting.menu])).toEqual(["pause", "cancel"]);
  });
  it("offers only Remove once a search is done or stopped, and nothing to a member who cannot remove", () => {
    for (const status of ["completed", "cancelled"] as const) {
      expect(batchRowActions(status, { canRemove: true })).toMatchObject({ buttons: [], menu: [{ id: "remove" }] });
      expect(batchRowActions(status, { canRemove: false })).toEqual({ buttons: [], menu: [] });
    }
  });
  it("puts Remove last and Stop before it, in every status", () => {
    for (const status of statuses) {
      const menu = ids(batchRowActions(status, { canRemove: true }).menu);
      if (menu.includes("remove")) expect(menu.at(-1)).toBe("remove");
      if (menu.includes("cancel")) expect(menu.indexOf("cancel")).toBe(menu.length - (menu.includes("remove") ? 2 : 1));
    }
  });
  it("offers only actions the server accepts, except the batch routes for run, rerun and remove", () => {
    for (const status of statuses) {
      const { buttons, menu } = batchRowActions(status, { canRemove: true });
      for (const { id } of [...buttons, ...menu]) if (id === "pause" || id === "resume" || id === "cancel") expect(canApply(status, id)).toBe(true);
    }
  });
});

describe("active statuses", () => {
  it("counts queued, running and waiting-for-limit searches as active", () => {
    for (const status of ["queued", "running", "paused_limit"]) expect(isActiveStatus(status)).toBe(true);
    for (const status of ["paused", "completed", "failed", "cancelled"]) expect(isActiveStatus(status)).toBe(false);
  });
  it("reads a list of statuses and a summary of counts, ignoring zero counts", () => {
    expect(hasActiveSearch(["completed", "running"])).toBe(true);
    expect(hasActiveSearch(["completed", "failed", "paused"])).toBe(false);
    expect(hasActiveSearch({ completed: 3, queued: 0 })).toBe(false);
    expect(hasActiveSearch({ completed: 3, paused_limit: 1 })).toBe(true);
    expect(hasActiveSearch({})).toBe(false);
  });
});
