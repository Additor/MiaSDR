import { describe, expect, it } from "vitest";
import { campaignRow, campaignTotals, channelsReport, linkedinReport, ratio, repliesReport, replyBucket, timeSeriesReport, unknownRate, attempted, type CampaignCounts } from "./metrics";
import { campaignsTable, toCsv } from "./export";
import { addDays, AnalyticsInputError, dayCount, eachDay, resolveRange } from "./range";

const sends = (sent = 0, unknown = 0, failed = 0, inFlight = 0) => ({ sent, unknown, failed, inFlight });
const campaign = (over: Partial<CampaignCounts> = {}): CampaignCounts => ({
  campaignId: "c1",
  name: "Launch",
  channel: "email",
  status: "active",
  enrolled: 10,
  contacted: 8,
  replied: 2,
  bounced: 1,
  sends: sends(8, 1, 1, 0),
  ...over,
});

describe("ratio", () => {
  it("returns null for an empty denominator", () => {
    expect(ratio(0, 0)).toBeNull();
    expect(ratio(3, 0)).toBeNull();
  });
  it("does not clamp or round", () => {
    expect(ratio(1, 4)).toBe(0.25);
  });
});

describe("send counts", () => {
  it("keeps unknown sends out of sent and counts them as attempts", () => {
    const c = sends(8, 1, 1, 2);
    expect(attempted(c)).toBe(12);
    expect(unknownRate(c)).toBeCloseTo(1 / 12);
    expect(c.sent).toBe(8);
  });
  it("has no unknown rate before any attempt", () => {
    expect(unknownRate(sends())).toBeNull();
  });
});

describe("campaign rows", () => {
  it("divides replies and bounces by contacted", () => {
    const row = campaignRow(campaign());
    expect(row.replyRate).toBe(0.25);
    expect(row.bounceRate).toBe(0.125);
    expect(row.unknownRate).toBeCloseTo(0.1);
  });
  it("shows no rates for a campaign nobody was contacted in", () => {
    const row = campaignRow(campaign({ contacted: 0, replied: 0, bounced: 0, sends: sends() }));
    expect(row.replyRate).toBeNull();
    expect(row.bounceRate).toBeNull();
  });
  it("sums totals without mixing unknown into sent", () => {
    const totals = campaignTotals([campaign(), campaign({ campaignId: "c2", contacted: 2, replied: 2, bounced: 0, sends: sends(2, 3, 0, 0) })]);
    expect(totals.contacted).toBe(10);
    expect(totals.replyRate).toBe(0.4);
    expect(totals.sends).toEqual(sends(10, 4, 1, 0));
  });
});

describe("channels report", () => {
  it("always lists both channels", () => {
    const report = channelsReport([{ channel: "linkedin", contacted: 4, replied: 1, bounced: 0, sends: sends(4) }], []);
    expect(report.channels.map((c) => c.channel)).toEqual(["email", "linkedin"]);
    expect(report.channels[0].replyRate).toBeNull();
    expect(report.channels[1].replyRate).toBe(0.25);
  });
});

describe("linkedin report", () => {
  it("rates stages against the stage before", () => {
    const report = linkedinReport({
      campaigns: [
        { campaignId: "a", name: "A", invited: 10, accepted: 4, messaged: 2, replied: 1 },
        { campaignId: "b", name: "B", invited: 10, accepted: 0, messaged: 0, replied: 0 },
      ],
      events: { invites: sends(20), messages: sends(2), accepted: 4, replies: 1 },
      accounts: [],
    });
    expect(report.funnel).toMatchObject({ invited: 20, accepted: 4, acceptanceRate: 0.2, messageRate: 0.5, replyRate: 0.25 });
    expect(report.campaigns[1].replyRate).toBeNull();
  });
});

describe("reply buckets", () => {
  it("maps classification state to a bucket", () => {
    expect(replyBucket(null, null)).toBe("unclassified");
    expect(replyBucket("proposed", "interested")).toBe("pending_review");
    expect(replyBucket("auto_applied", "interested")).toBe("interested");
    expect(replyBucket("overridden", "not_interested")).toBe("not_interested");
    expect(replyBucket("accepted", null)).toBe("unclassified");
  });
  it("totals buckets and hides suppressions when asked", () => {
    const report = repliesReport(
      [
        { channel: "email", bucket: "interested", subcategory: "Meeting requested", replies: 2 },
        { channel: "linkedin", bucket: "interested", subcategory: "Meeting requested", replies: 1 },
        { channel: "email", bucket: "unclassified", subcategory: null, replies: 1 },
      ],
      null,
    );
    expect(report.total).toBe(4);
    expect(report.classifiedShare).toBe(0.75);
    expect(report.byReplyType).toEqual([{ bucket: "interested", name: "Meeting requested", replies: 3 }]);
    expect(report.byChannel[1].total).toBe(1);
    expect(report.suppressions).toBeNull();
  });
  it("fills missing suppression reasons with zero", () => {
    expect(repliesReport([], { bounced: 2 }).suppressions).toEqual({ unsubscribed: 0, bounced: 2, manual: 0, complaint: 0 });
  });
});

describe("time series", () => {
  it("fills days without events and ignores rows outside the range", () => {
    const days = eachDay({ from: "2026-03-28", to: "2026-03-30" });
    const report = timeSeriesReport(days, [
      { day: "2026-03-29", metric: "email_sent", count: 3 },
      { day: "2026-03-29", metric: "email_unknown", count: 1 },
      { day: "2026-04-05", metric: "email_sent", count: 9 },
    ]);
    expect(report.points.map((p) => p.email_sent)).toEqual([0, 3, 0]);
    expect(report.totals.email_sent).toBe(3);
    expect(report.totals.email_unknown).toBe(1);
  });
});

describe("range", () => {
  it("defaults to the 30 days ending today", () => {
    expect(resolveRange({}, "2026-10-15")).toEqual({ from: "2026-09-16", to: "2026-10-15" });
  });
  it("counts both ends and crosses DST changes as whole days", () => {
    expect(dayCount("2026-03-28", "2026-03-30")).toBe(3);
    expect(addDays("2026-03-01", 30)).toBe("2026-03-31");
    expect(eachDay({ from: "2026-10-24", to: "2026-11-02" })).toHaveLength(10);
  });
  it.each([
    [{ from: "2026-02-30", to: "2026-03-01" }],
    [{ from: "2026-03-02", to: "2026-03-01" }],
    [{ from: "2024-01-01", to: "2026-03-01" }],
    [{ from: "yesterday", to: "2026-03-01" }],
  ])("rejects %j", (input) => {
    expect(() => resolveRange(input, "2026-10-15")).toThrow(AnalyticsInputError);
  });
});

describe("csv", () => {
  it("quotes commas and defuses formulas", () => {
    expect(toCsv({ headers: ["a", "b"], rows: [["x,y", "=SUM(A1)"], [null, 3]] })).toBe('a,b\r\n"x,y",\'=SUM(A1)\r\n,3\r\n');
  });
  it("exports rates as percentages and the unknown column apart from sent", () => {
    const csv = toCsv(campaignsTable({ rows: [campaignRow(campaign())], totals: campaignTotals([campaign()]) }));
    const [header, row] = csv.split("\r\n");
    expect(header).toContain("Unknown outcome");
    expect(row).toBe("Launch,email,active,10,8,2,1,25,12.5,8,1,1,0");
  });
});
