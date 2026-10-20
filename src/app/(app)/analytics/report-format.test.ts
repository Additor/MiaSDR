import { describe, expect, it } from "vitest";
import type { AnalyticsResult } from "@/contexts/analytics/application/analytics-queries";
import { campaignsReport, channelsReport, type CampaignCounts } from "@/contexts/analytics/domain/metrics";
import { SMALL_SAMPLE_BELOW, countWithRate, rateDisplay, rateText, summaryItems } from "./report-format";

const scope = { range: { from: "2026-10-01", to: "2026-10-15" }, timeZone: "UTC", campaignId: null, linkedinAccountId: null, excludeArchived: false };
const sends = (sent = 0, unknown = 0, failed = 0, inFlight = 0) => ({ sent, unknown, failed, inFlight });
const campaign = (over: Partial<CampaignCounts> = {}): CampaignCounts => ({ campaignId: "c1", name: "Launch", channel: "email", status: "active", enrolled: 100, contacted: 40, replied: 10, bounced: 2, sends: sends(40, 3, 1, 0), ...over });

describe("rateDisplay", () => {
  it("is empty when nobody was contacted", () => {
    expect(rateDisplay(0, 0)).toEqual({ kind: "empty" });
  });
  it("shows x of n under the small-sample threshold", () => {
    expect(rateDisplay(1, 2)).toEqual({ kind: "fraction", text: "1 of 2" });
    expect(rateDisplay(5, SMALL_SAMPLE_BELOW - 1)).toEqual({ kind: "fraction", text: "5 of 19" });
  });
  it("shows a percentage from the threshold up", () => {
    expect(rateDisplay(5, SMALL_SAMPLE_BELOW)).toEqual({ kind: "percent", text: "25.0%" });
    expect(rateDisplay(1, 3000)).toEqual({ kind: "percent", text: "0.0%" });
  });
  it("formats thousands with the en-US convention", () => {
    expect(rateDisplay(1234, 1234)).toEqual({ kind: "percent", text: "100.0%" });
    expect(countWithRate(1234, 2000)).toBe("1,234 (61.7%)");
  });
});

describe("rateText and countWithRate", () => {
  it("print a dash for an empty denominator", () => {
    expect(rateText(0, 0)).toBe("-");
    expect(countWithRate(0, 0)).toBe("-");
  });
  it("print the fraction alone for a small sample", () => {
    expect(countWithRate(1, 2)).toBe("1 of 2");
  });
});

describe("summaryItems", () => {
  it("derives the campaigns summary from the totals row", () => {
    const data = campaignsReport([campaign(), campaign({ campaignId: "c2", contacted: 10, replied: 1, bounced: 0, sends: sends(10, 0, 0, 0) })]);
    const items = summaryItems({ view: "campaigns", data, scope } as AnalyticsResult);
    expect(items.map((i) => [i.label, i.value])).toEqual([
      ["Contacted", "50"],
      ["Replied", "11 (22.0%)"],
      ["Bounced", "2 (4.0%)"],
      ["Unknown outcome", "3"],
    ]);
    expect(items[1].hint).toBe("11 of 50 contacted");
    expect(items[3].hint).toContain("3 of 54 send attempts");
  });
  it("shows x of n when the window holds a small sample", () => {
    const data = campaignsReport([campaign({ contacted: 2, replied: 1, bounced: 0, sends: sends(2) })]);
    const items = summaryItems({ view: "campaigns", data, scope } as AnalyticsResult);
    expect(items[1].value).toBe("1 of 2");
    expect(items[2].value).toBe("0 of 2");
  });
  it("says so when there were no send attempts", () => {
    const items = summaryItems({ view: "campaigns", data: campaignsReport([]), scope } as AnalyticsResult);
    expect(items[1].value).toBe("-");
    expect(items[3].hint).toBe("No send attempts in this window.");
  });
  it("adds both channels in the channels summary", () => {
    const data = channelsReport(
      [
        { channel: "email", contacted: 30, replied: 3, bounced: 1, sends: sends(30, 1) },
        { channel: "linkedin", contacted: 20, replied: 2, bounced: 0, sends: sends(20, 2) },
      ],
      [],
    );
    const items = summaryItems({ view: "channels", data, scope } as AnalyticsResult);
    expect(items.map((i) => i.value)).toEqual(["50", "5 (10.0%)", "1 (2.0%)", "3"]);
  });
});
