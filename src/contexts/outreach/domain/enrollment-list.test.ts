import { describe, expect, it } from "vitest";
import type { EnrollmentListQuery } from "./enrollment-list";
import { ENROLLMENT_TABS, TAB_STATUSES, campaignLeadTabs, countsByTab, enrollmentListHref, enrollmentSelectionKey, enrollmentTabOf, parseEnrollmentListQuery, retriesUsed, statusesForTab, tabOfStatus } from "./enrollment-list";

const ALL_STATUSES = ["pending", "active", "replied", "completed", "bounced", "suppressed", "failed", "cancelled", "removed"];
const CAMPAIGN_STATUSES = ["draft", "active", "paused", "completed"];

describe("enrollment filters", () => {
  it.each(CAMPAIGN_STATUSES)("places every enrollment status under exactly one filter of a %s campaign", (campaignStatus) => {
    const shown = campaignLeadTabs(campaignStatus, countsByTab([], campaignStatus), "all").concat("removed").filter((t) => t !== "all");
    for (const status of ALL_STATUSES) {
      const tabs = shown.filter((tab) => (statusesForTab(tab, campaignStatus) as readonly string[]).includes(status));
      expect(tabs, status).toHaveLength(1);
      expect(tabOfStatus(status, campaignStatus)).toBe(tabs[0]);
    }
  });

  it("covers every status in the filters a campaign can show", () => {
    expect([...new Set(Object.values(TAB_STATUSES).flat())].sort()).toEqual([...ALL_STATUSES].sort());
  });

  it("reads pending and active by the campaign status", () => {
    expect(statusesForTab("queued", "active")).toEqual(["pending"]);
    expect(statusesForTab("in_sequence", "active")).toEqual(["active"]);
    expect(statusesForTab("paused", "active")).toEqual([]);
    expect(statusesForTab("paused", "paused")).toEqual(["pending", "active"]);
    expect(statusesForTab("paused", "draft")).toEqual(["pending", "active"]);
    expect(statusesForTab("queued", "paused")).toEqual([]);
    expect(tabOfStatus("pending", "draft")).toBe("paused");
    expect(tabOfStatus("active")).toBe("in_sequence");
  });

  it("selects every status but removed for the all filter", () => {
    expect([...statusesForTab("all")].sort()).toEqual(ALL_STATUSES.filter((s) => s !== "removed").sort());
    expect(statusesForTab("stopped", "active")).toEqual(["bounced", "suppressed", "failed", "cancelled"]);
    expect(statusesForTab("finished", "completed")).toEqual(["completed"]);
  });

  it("folds status counts into filter counts by the campaign status", () => {
    const rows = [
      { status: "pending", n: 3 },
      { status: "active", n: 4 },
      { status: "bounced", n: 1 },
      { status: "suppressed", n: 2 },
      { status: "failed", n: 1 },
      { status: "cancelled", n: 1 },
      { status: "completed", n: 6 },
      { status: "removed", n: 5 },
      { status: "mystery", n: 9 },
    ];
    expect(countsByTab(rows, "active")).toEqual({ all: 18, queued: 3, in_sequence: 4, paused: 0, replied: 0, finished: 6, stopped: 5, removed: 5 });
    expect(countsByTab(rows, "paused")).toEqual({ all: 18, queued: 0, in_sequence: 0, paused: 7, replied: 0, finished: 6, stopped: 5, removed: 5 });
    expect(countsByTab(rows).paused).toBe(7);
    expect(Object.keys(countsByTab(rows)).sort()).toEqual([...ENROLLMENT_TABS].sort());
  });

  it("offers Queued and In sequence while the campaign runs, Paused otherwise, and Removed once a lead was removed", () => {
    const none = countsByTab([]);
    expect(campaignLeadTabs("active", none, "all")).toEqual(["all", "queued", "in_sequence", "replied", "finished", "stopped"]);
    expect(campaignLeadTabs("paused", countsByTab([{ status: "removed", n: 1 }]), "all")).toEqual(["all", "paused", "replied", "finished", "stopped", "removed"]);
    expect(campaignLeadTabs("draft", none, "queued")).toEqual(["all", "queued", "paused", "replied", "finished", "stopped"]);
  });

  it("reads the older filter values as their successors", () => {
    expect(enrollmentTabOf("pending")).toBe("queued");
    expect(enrollmentTabOf("completed")).toBe("finished");
    expect(enrollmentTabOf("bounced")).toBe("stopped");
    expect(enrollmentTabOf("in_sequence")).toBe("in_sequence");
    expect(enrollmentTabOf("settings")).toBeNull();
    expect(enrollmentTabOf(undefined)).toBeNull();
  });
});

describe("parseEnrollmentListQuery", () => {
  it("applies defaults", () => {
    expect(parseEnrollmentListQuery({})).toEqual({ tab: "all", search: "", page: 1, pageSize: 50 });
  });
  it("reads valid parameters and trims the search", () => {
    expect(parseEnrollmentListQuery({ tab: "stopped", q: "  acme ", size: "100", page: "3" })).toEqual({ tab: "stopped", search: "acme", page: 3, pageSize: 100 });
    expect(parseEnrollmentListQuery({ tab: "bounced" }).tab).toBe("stopped");
  });
  it("falls back on unknown values", () => {
    expect(parseEnrollmentListQuery({ tab: "nope", size: "7", page: "-4" })).toEqual({ tab: "all", search: "", page: 1, pageSize: 50 });
    expect(parseEnrollmentListQuery({ tab: ["replied", "x"], page: "abc" }).tab).toBe("replied");
  });
  it("caps the search length", () => {
    expect(parseEnrollmentListQuery({ q: "a".repeat(500) }).search).toHaveLength(100);
  });
});

describe("enrollmentListHref", () => {
  it("leaves defaults out and encodes the search", () => {
    expect(enrollmentListHref("/campaigns/1", {})).toBe("/campaigns/1");
    expect(enrollmentListHref("/campaigns/1", { tab: "replied", search: "a&b", pageSize: 20, page: 2 })).toBe("/campaigns/1?tab=replied&q=a%26b&size=20&page=2");
  });
});

describe("enrollmentSelectionKey", () => {
  it("changes with the tab, search, page size and page, and not between identical views", () => {
    const view = { tab: "all", search: "", pageSize: 50, page: 1 } as const satisfies Partial<EnrollmentListQuery>;
    const key = enrollmentSelectionKey("c1", view);
    expect(enrollmentSelectionKey("c1", { ...view })).toBe(key);
    const others = ([{ tab: "replied" }, { search: "ann" }, { pageSize: 20 }, { page: 2 }] as const).map((change) => enrollmentSelectionKey("c1", { ...view, ...change }));
    expect(new Set([key, ...others]).size).toBe(5);
    expect(enrollmentSelectionKey("c2", view)).not.toBe(key);
  });
});

describe("retriesUsed", () => {
  it("counts failed attempts", () => {
    expect(retriesUsed("sent", 1)).toBe(0);
    expect(retriesUsed("sending", 2)).toBe(1);
    expect(retriesUsed("failed", 3)).toBe(3);
  });
});
