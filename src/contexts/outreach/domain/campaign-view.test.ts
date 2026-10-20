import { describe, expect, it } from "vitest";
import {
  blockerTab,
  campaignStatusLabel,
  campaignTabHref,
  campaignSummary,
  enrollmentDisplayStatus,
  channelLabel,
  emailProgressText,
  enrollmentStatusLabel,
  enrollNeedsConfirmation,
  leadsListHref,
  linkedinProgressText,
  parseCampaignTab,
  parseLeadsQuery,
  sendingRulesLine,
  startBlockers,
  startSummaryLines,
  stopReasonDetail,
  stopReasonLabel,
  stopReasonNote,
} from "./campaign-view";
import type { TabCounts } from "./enrollment-list";

const counts = (over: Partial<TabCounts> = {}): TabCounts => ({ all: 0, queued: 0, in_sequence: 0, paused: 0, replied: 0, finished: 0, stopped: 0, removed: 0, ...over });

describe("labels", () => {
  it("names campaign and enrollment statuses in sentence case", () => {
    expect(campaignStatusLabel("active")).toBe("Active");
    expect(enrollmentStatusLabel("active")).toBe("In sequence");
    expect(enrollmentStatusLabel("suppressed")).toBe("Suppressed");
  });
  it("falls back to a readable label for a status it does not know", () => {
    expect(campaignStatusLabel("on_hold")).toBe("On hold");
    expect(enrollmentStatusLabel("needs_review")).toBe("Needs review");
  });
  it("names the channels and humanizes one it does not know", () => {
    expect(channelLabel("email")).toBe("Email");
    expect(channelLabel("linkedin")).toBe("LinkedIn");
    expect(channelLabel("sms")).toBe("Sms");
  });
  it("labels stop reasons, humanizes bare tokens and leaves sentences alone", () => {
    expect(stopReasonLabel("do_not_contact")).toBe("Do not contact");
    expect(stopReasonLabel("some_new_reason")).toBe("Some new reason");
    expect(stopReasonLabel("Mailbox refused: 550 no such user")).toBe("Mailbox refused: 550 no such user");
  });
  it("drops a reason that only repeats the status", () => {
    expect(stopReasonNote("replied", "replied")).toBeNull();
    expect(stopReasonNote("bounced", "bounced")).toBeNull();
    expect(stopReasonNote("suppressed", "do_not_contact")).toBe("Do not contact");
    expect(stopReasonNote("suppressed", null)).toBeNull();
  });
  it("explains the account rule in a sentence and labels other reasons", () => {
    expect(stopReasonDetail("already_contacted_by_account")).toMatch(/already invited this person in another campaign/);
    expect(stopReasonDetail("converted")).toBe("Became a contact");
    expect(stopReasonDetail("Mailbox refused")).toBe("Mailbox refused");
  });
  it("shows a live enrollment of a campaign that is not active as paused with it", () => {
    expect(enrollmentDisplayStatus("active", "paused")).toEqual({ status: "paused", label: "Paused with campaign" });
    expect(enrollmentDisplayStatus("pending", "draft")).toEqual({ status: "paused", label: "Paused with campaign" });
    expect(enrollmentDisplayStatus("active", "active")).toEqual({ status: "active", label: "In sequence" });
    expect(enrollmentDisplayStatus("completed", "paused")).toEqual({ status: "completed", label: "Completed" });
  });
  it("labels a cancelled enrollment of a converted lead", () => {
    expect(stopReasonLabel("converted")).toBe("Became a contact");
    expect(stopReasonNote("cancelled", "converted")).toBe("Became a contact");
  });
});

describe("campaignSummary", () => {
  it("uses the same labels for both channels and folds tab counts into them", () => {
    const tabs = counts({ all: 1234, queued: 100, in_sequence: 20, replied: 5, stopped: 9, finished: 1100 });
    const email = campaignSummary({ channel: "email", counts: tabs, sent: 1500 });
    const linkedin = campaignSummary({ channel: "linkedin", counts: tabs, sent: 1500 });
    expect(email.map((i) => i.label)).toEqual(linkedin.map((i) => i.label));
    expect(Object.fromEntries(email.map((i) => [i.label, i.value]))).toEqual({
      Leads: "1,234",
      Sent: "1,500",
      "In progress": "120",
      Replied: "5",
      Finished: "1,100",
      Stopped: "9",
    });
  });
  it("counts paused leads as in progress", () => {
    const summary = campaignSummary({ channel: "email", counts: counts({ all: 10, paused: 7, replied: 1, stopped: 2 }), sent: 3 });
    expect(summary.find((i) => i.label === "In progress")?.value).toBe("7");
  });
  it("describes what Sent counts per channel", () => {
    const sent = (channel: "email" | "linkedin") => campaignSummary({ channel, counts: counts(), sent: 0 }).find((i) => i.label === "Sent")?.hint;
    expect(sent("email")).toBe("Emails sent.");
    expect(sent("linkedin")).toBe("Invitations and messages sent.");
  });
});

describe("progress text", () => {
  it("shows replied beside sent and takes replies out of stopped", () => {
    expect(emailProgressText({ sent: 1200, replied: 30, completed: 4, stopped: 41 })).toBe("1,200 sent, 30 replied, 4 finished, 11 stopped");
  });
  it("never goes below zero when a count is stale", () => {
    expect(emailProgressText({ sent: 0, replied: 3, completed: 0, stopped: 1 })).toContain("0 stopped");
  });
  it("formats LinkedIn progress with the same grouping", () => {
    expect(linkedinProgressText({ invited: 2000, connected: 10, replied: 1 })).toBe("2,000 invited, 10 connected, 1 replied");
  });
});

describe("startBlockers", () => {
  const ready: Parameters<typeof startBlockers>[0] = { channel: "email", status: "draft", leads: 3, connectedSenders: 1, offlineAssigned: [], stepIssues: 0, placeholderSteps: [] };
  it("is empty when a draft is ready", () => {
    expect(startBlockers(ready)).toEqual([]);
  });
  it("is empty for a campaign that already started once", () => {
    expect(startBlockers({ ...ready, status: "paused", leads: 0, connectedSenders: 0 })).toEqual([]);
  });
  it("lists each missing piece in the order a person fixes it", () => {
    const codes = startBlockers({ ...ready, leads: 0, connectedSenders: 0, stepIssues: 2, placeholderSteps: [1, 2] }).map((b) => b.code);
    expect(codes).toEqual(["no_sender", "fix_steps", "unfinished_steps", "no_leads"]);
  });
  it("names the channel's sender and the offline ones", () => {
    expect(startBlockers({ ...ready, channel: "linkedin", connectedSenders: 0 })[0].message).toBe("Connect a LinkedIn account in Settings to start.");
    expect(startBlockers({ ...ready, offlineAssigned: ["ana@x.test", "bo@x.test"] })[0].message).toBe("Reconnect or remove ana@x.test, bo@x.test under Senders to start.");
  });
  it("sends each blocker to the tab that fixes it", () => {
    expect(blockerTab("fix_steps")).toBe("sequence");
    expect(blockerTab("unfinished_steps")).toBe("sequence");
    expect(blockerTab("offline_sender")).toBe("settings");
    expect(blockerTab("no_leads")).toBe("leads");
    // Connecting a mailbox or account happens in the app settings, not on the campaign page.
    expect(blockerTab("no_sender")).toBeNull();
  });
});

describe("startSummaryLines", () => {
  it("lists the lead count, the senders and the email send rules", () => {
    expect(startSummaryLines({ channel: "email", leads: 1, senders: ["ana@x.test"], gapMinutes: [18, 24] })).toEqual([
      "1 lead is in this campaign.",
      "Sending from ana@x.test.",
      "Each mailbox sends inside its working hours and under its daily limit, 18 to 24 minutes apart.",
    ]);
  });
  it("says every connected mailbox when none is assigned", () => {
    expect(startSummaryLines({ channel: "email", leads: 2000, senders: [], gapMinutes: [20, 20] })).toEqual([
      "2,000 leads are in this campaign.",
      "Sending from every connected mailbox.",
      "Each mailbox sends inside its working hours and under its daily limit, 20 minutes apart.",
    ]);
  });
  it("summarises LinkedIn invitation limits across accounts", () => {
    const lines = startSummaryLines({ channel: "linkedin", leads: 4, senders: [], inviteLimits: [{ daily: 20, weekly: 100 }, { daily: 30, weekly: 100 }] });
    expect(lines[1]).toBe("Sending from every connected account.");
    expect(lines[2]).toBe("Each account sends 20 to 30 invitations a day and 100 a week, inside its working hours.");
  });
});

describe("enrollNeedsConfirmation", () => {
  it("asks for an empty search as soon as it would add anyone", () => {
    expect(enrollNeedsConfirmation({ query: "", wouldAdd: 1 })).toBe(true);
    expect(enrollNeedsConfirmation({ query: "  ", wouldAdd: 3 })).toBe(true);
  });
  it("asks for a large match and skips a small one", () => {
    expect(enrollNeedsConfirmation({ query: "cto", wouldAdd: 49 })).toBe(false);
    expect(enrollNeedsConfirmation({ query: "cto", wouldAdd: 50 })).toBe(true);
  });
  it("does not ask when nobody would be added", () => {
    expect(enrollNeedsConfirmation({ query: "", wouldAdd: 0 })).toBe(false);
  });
});

describe("campaign page tabs", () => {
  it("defaults to Leads for a missing or unknown value", () => {
    expect(parseCampaignTab(undefined)).toBe("leads");
    expect(parseCampaignTab("nope")).toBe("leads");
    expect(parseCampaignTab("replied")).toBe("leads");
    expect(parseCampaignTab(["sequence", "settings"])).toBe("sequence");
    expect(parseCampaignTab("settings")).toBe("settings");
  });
  it("keeps the Leads URL bare", () => {
    expect(campaignTabHref("/campaigns/1", "leads")).toBe("/campaigns/1");
    expect(campaignTabHref("/campaigns/1", "sequence")).toBe("/campaigns/1?tab=sequence");
  });
  it("reads the lead filter from status and from an older tab link", () => {
    expect(parseLeadsQuery({ status: "replied", q: "ana", page: "2" })).toEqual({ tab: "replied", search: "ana", page: 2, pageSize: 50 });
    expect(parseLeadsQuery({ tab: "finished" }).tab).toBe("finished");
    expect(parseLeadsQuery({ tab: "bounced" }).tab).toBe("stopped");
    expect(parseLeadsQuery({ status: "pending" }).tab).toBe("queued");
    expect(parseLeadsQuery({ status: "completed" }).tab).toBe("finished");
    expect(parseLeadsQuery({ tab: "settings" }).tab).toBe("all");
    expect(parseLeadsQuery({ tab: "bounced", status: "replied" }).tab).toBe("replied");
    expect(parseLeadsQuery({}).tab).toBe("all");
  });
  it("writes the lead filter to status and leaves defaults out", () => {
    expect(leadsListHref("/campaigns/1", { tab: "all", search: "", page: 1, pageSize: 50 })).toBe("/campaigns/1");
    expect(leadsListHref("/campaigns/1", { tab: "replied", search: "a&b", pageSize: 20, page: 2 })).toBe("/campaigns/1?status=replied&q=a%26b&size=20&page=2");
    expect(leadsListHref("/campaigns/1", { tab: "stopped" })).toBe("/campaigns/1?status=stopped");
  });
});

describe("sendingRulesLine", () => {
  it("matches the line the Start dialog shows", () => {
    expect(sendingRulesLine({ channel: "email", gapMinutes: [18, 24] })).toBe("Each mailbox sends inside its working hours and under its daily limit, 18 to 24 minutes apart.");
    expect(sendingRulesLine({ channel: "email" })).toContain("18 to 24 minutes apart");
    expect(sendingRulesLine({ channel: "linkedin", inviteLimits: [{ daily: 20, weekly: 100 }] })).toBe("Each account sends 20 invitations a day and 100 a week, inside its working hours.");
  });
  it("has nothing to say for LinkedIn without a sending account", () => {
    expect(sendingRulesLine({ channel: "linkedin", inviteLimits: [] })).toBeNull();
    expect(sendingRulesLine({ channel: "linkedin" })).toBeNull();
  });
});
