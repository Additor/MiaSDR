import { describe, expect, it } from "vitest";
import {
  activeFilterCount,
  dayGroupOf,
  groupByDay,
  inboxHref,
  isAutomatedMessage,
  parseInboxParams,
  resolveDateRange,
} from "./inbox-filter";

// Wednesday 2026-10-14 15:30 UTC.
const NOW = new Date("2026-10-14T15:30:00Z");
const ID = "11111111-1111-4111-8111-111111111111";

describe("resolveDateRange", () => {
  it("returns an open range for all time and unknown modes", () => {
    expect(resolveDateRange({ mode: "all" }, NOW)).toEqual({ start: null, end: null });
    expect(resolveDateRange({ mode: "bogus" }, NOW)).toEqual({ start: null, end: null });
    expect(resolveDateRange({}, NOW)).toEqual({ start: null, end: null });
  });

  it("covers today and yesterday as whole UTC days", () => {
    expect(resolveDateRange({ mode: "today" }, NOW)).toEqual({ start: new Date("2026-10-14T00:00:00Z"), end: new Date("2026-10-15T00:00:00Z") });
    expect(resolveDateRange({ mode: "yesterday" }, NOW)).toEqual({ start: new Date("2026-10-13T00:00:00Z"), end: new Date("2026-10-14T00:00:00Z") });
  });

  it("includes the end day of a custom range", () => {
    expect(resolveDateRange({ mode: "custom", from: "2026-10-01", to: "2026-10-03" }, NOW)).toEqual({
      start: new Date("2026-10-01T00:00:00Z"),
      end: new Date("2026-10-04T00:00:00Z"),
    });
  });

  it("swaps a reversed range, leaves a bad side open and rejects impossible dates", () => {
    expect(resolveDateRange({ mode: "custom", from: "2026-10-03", to: "2026-10-01" }, NOW)).toEqual({
      start: new Date("2026-10-01T00:00:00Z"),
      end: new Date("2026-10-04T00:00:00Z"),
    });
    expect(resolveDateRange({ mode: "custom", from: "2026-10-03", to: "soon" }, NOW)).toEqual({ start: new Date("2026-10-03T00:00:00Z"), end: null });
    expect(resolveDateRange({ mode: "custom", from: "2026-02-31" }, NOW)).toEqual({ start: null, end: null });
  });

  it("handles the day boundary exactly", () => {
    const midnight = new Date("2026-10-14T00:00:00Z");
    expect(resolveDateRange({ mode: "today" }, midnight).start).toEqual(midnight);
    expect(resolveDateRange({ mode: "today" }, new Date("2026-10-14T23:59:59.999Z")).end).toEqual(new Date("2026-10-15T00:00:00Z"));
  });
});

describe("resolveDateRange in a time zone", () => {
  // 2026-10-14 15:30 UTC is 2026-10-15 00:30 in Seoul and 2026-10-14 08:30 in Los Angeles.
  it("starts today at local midnight", () => {
    expect(resolveDateRange({ mode: "today" }, NOW, "Asia/Seoul")).toEqual({ start: new Date("2026-10-14T15:00:00Z"), end: new Date("2026-10-15T15:00:00Z") });
    expect(resolveDateRange({ mode: "yesterday" }, NOW, "Asia/Seoul")).toEqual({ start: new Date("2026-10-13T15:00:00Z"), end: new Date("2026-10-14T15:00:00Z") });
    expect(resolveDateRange({ mode: "today" }, NOW, "America/Los_Angeles")).toEqual({ start: new Date("2026-10-14T07:00:00Z"), end: new Date("2026-10-15T07:00:00Z") });
  });

  it("includes the end day of a custom range in that zone", () => {
    expect(resolveDateRange({ mode: "custom", from: "2026-10-01", to: "2026-10-03" }, NOW, "Asia/Seoul")).toEqual({
      start: new Date("2026-09-30T15:00:00Z"),
      end: new Date("2026-10-03T15:00:00Z"),
    });
  });

  it("gives a day its real length across a clock change", () => {
    const range = resolveDateRange({ mode: "custom", from: "2026-11-01", to: "2026-11-01" }, NOW, "America/Los_Angeles");
    expect((range.end!.getTime() - range.start!.getTime()) / 3_600_000).toBe(25);
  });

  it("swaps a reversed range and leaves a bad side open, as it does in UTC", () => {
    expect(resolveDateRange({ mode: "custom", from: "2026-10-03", to: "2026-10-01" }, NOW, "Asia/Seoul")).toEqual({
      start: new Date("2026-09-30T15:00:00Z"),
      end: new Date("2026-10-03T15:00:00Z"),
    });
    expect(resolveDateRange({ mode: "custom", from: "2026-02-31" }, NOW, "Asia/Seoul")).toEqual({ start: null, end: null });
  });
});

describe("isAutomatedMessage", () => {
  it("trusts the header flags", () => {
    expect(isAutomatedMessage({ autoReply: true })).toBe(true);
    expect(isAutomatedMessage({ possibleBounce: true })).toBe(true);
  });

  it.each(["noreply@x.test", "no-reply@x.test", "No_Reply@x.test", "do-not-reply@x.test", "donotreply@x.test", "mailer-daemon@x.test", "postmaster@x.test", "dmarc-reports@x.test", "bounces@x.test", "Service <notifications.noreply@x.test>"])(
    "flags the sender %s",
    (from) => expect(isAutomatedMessage({ from })).toBe(true),
  );

  it.each(["Report domain: acme.test Submitter: google.com", "DMARC Aggregate Report", "Delivery Status Notification (Failure)", "Undeliverable: hello", "Mail delivery failed: returning message", "Returned mail: see transcript"])(
    "flags the subject %s",
    (subject) => expect(isAutomatedMessage({ subject })).toBe(true),
  );

  it.each([
    { from: "jane@acme.test", subject: "Re: pricing" },
    { from: "noreplyton@acme.test", subject: "Reply about the report" },
    { from: "anna.bouncer@acme.test", subject: "Let's talk" },
    { from: "reply@acme.test", subject: "Delivery schedule for Q4" },
    { from: null, subject: null },
  ])("leaves a human message alone: %j", (probe) => expect(isAutomatedMessage(probe)).toBe(false));
});

describe("day groups", () => {
  it("assigns Today, Yesterday, This week and Earlier by UTC day", () => {
    expect(dayGroupOf(new Date("2026-10-14T00:00:00Z"), NOW)).toBe("today");
    expect(dayGroupOf(new Date("2026-10-13T23:59:59Z"), NOW)).toBe("yesterday");
    expect(dayGroupOf(new Date("2026-10-13T00:00:00Z"), NOW)).toBe("yesterday");
    expect(dayGroupOf(new Date("2026-10-12T23:59:59Z"), NOW)).toBe("week");
    expect(dayGroupOf(new Date("2026-10-07T00:00:00Z"), NOW)).toBe("week");
    expect(dayGroupOf(new Date("2026-10-06T23:59:59Z"), NOW)).toBe("earlier");
  });

  it("groups newest-first rows in order and omits empty groups", () => {
    const rows = ["2026-10-14T09:00:00Z", "2026-10-14T01:00:00Z", "2026-10-12T09:00:00Z", "2026-09-01T09:00:00Z"].map((at) => ({ at: new Date(at) }));
    const groups = groupByDay(rows, (r) => r.at, NOW);
    expect(groups.map((g) => [g.label, g.rows.length])).toEqual([["Today", 2], ["This week", 1], ["Earlier", 1]]);
    expect(groupByDay([], () => NOW, NOW)).toEqual([]);
  });
});

describe("parseInboxParams and inboxHref", () => {
  it("defaults to the plain list", () => {
    expect(parseInboxParams({})).toMatchObject({ view: "all", query: "", page: 1, leadIds: [], campaignIds: [], dateMode: "all" });
    expect(activeFilterCount(parseInboxParams({}))).toBe(0);
  });

  it("drops unknown or malformed values", () => {
    const p = parseInboxParams({ view: "nope", page: "-3", campaign: ["x", ID], mailbox: "zzz", subcategory: ["Bad Key", "demo_request"], category: ["interested", "weird"], range: "forever" });
    expect(p).toMatchObject({ view: "all", page: 1, campaignIds: [ID], mailboxIds: [], subcategoryKeys: ["demo_request"], categoryKeys: ["interested"], dateMode: "all" });
  });

  it("reads lead ids and lead text from the same parameter", () => {
    expect(parseInboxParams({ lead: [ID, "ada"] })).toMatchObject({ leadIds: [ID], leadQuery: "ada" });
    expect(parseInboxParams({ lead: `${ID},${ID.replace(/1/g, "2")}` }).leadIds).toHaveLength(2);
  });

  it("treats typed dates as a custom range and ignores them for today", () => {
    expect(parseInboxParams({ range: "all", from: "2026-10-01" })).toMatchObject({ dateMode: "custom", dateFrom: "2026-10-01" });
    expect(parseInboxParams({ range: "today", from: "2026-10-01" }).dateMode).toBe("today");
    expect(parseInboxParams({ range: "custom", from: "2026-13-01" })).toMatchObject({ dateMode: "custom", dateFrom: "" });
  });

  it("round-trips through the link builder", () => {
    const p = parseInboxParams({ q: "pricing", view: "sent", lead: ID, campaign: ID, subcategory: "demo_request", category: "interested", range: "custom", from: "2026-10-01", to: "2026-10-03", page: "2" });
    expect(parseInboxParams(Object.fromEntries(new URL(inboxHref(p), "http://x").searchParams.entries()))).toEqual(p);
    expect(activeFilterCount(p)).toBe(5);
  });

  it("keeps defaults out of the URL", () => {
    expect(inboxHref(parseInboxParams({}))).toBe("/inbox");
    expect(inboxHref(parseInboxParams({ view: "sent" }), { page: 1 })).toBe("/inbox?view=sent");
    expect(inboxHref(parseInboxParams({ q: "a b" }), { view: "unread", page: 3 })).toBe("/inbox?q=a+b&view=unread&page=3");
  });
});
