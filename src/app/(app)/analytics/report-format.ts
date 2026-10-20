import type { SummaryItem } from "@/components/shell/summary-line";
import type { AnalyticsResult } from "@/contexts/analytics/application/analytics-queries";
import { attempted, ratio, type SendCounts } from "@/contexts/analytics/domain/metrics";

/** A rate over fewer people than this reads as "x of n". One person moves a rate over 19 people by 5 points or more. */
export const SMALL_SAMPLE_BELOW = 20;

export const int = (value: number) => value.toLocaleString("en-US");
export const percent = (value: number) => `${(value * 100).toFixed(1)}%`;

export type RateDisplay =
  | { kind: "empty" }
  /** Too few people for a stable percentage; `text` is "1 of 2". */
  | { kind: "fraction"; text: string }
  | { kind: "percent"; text: string };

export function rateDisplay(part: number, whole: number): RateDisplay {
  const value = ratio(part, whole);
  if (value === null) return { kind: "empty" };
  if (whole < SMALL_SAMPLE_BELOW) return { kind: "fraction", text: `${int(part)} of ${int(whole)}` };
  return { kind: "percent", text: percent(value) };
}

/** The rate alone: "11.7%", "1 of 2" for a small sample, "-" when the denominator is 0. */
export function rateText(part: number, whole: number): string {
  const rate = rateDisplay(part, whole);
  return rate.kind === "empty" ? "-" : rate.text;
}

/** Summary text for a count and its rate: "14 (11.7%)", "1 of 2" for a small sample, "-" when the denominator is 0. */
export function countWithRate(part: number, whole: number): string {
  const rate = rateDisplay(part, whole);
  if (rate.kind === "empty") return "-";
  return rate.kind === "fraction" ? rate.text : `${int(part)} (${rate.text})`;
}

function unknownItem(unknown: number, sends: SendCounts): SummaryItem {
  const total = attempted(sends);
  return {
    label: "Unknown outcome",
    value: int(unknown),
    hint: total > 0 ? `${int(unknown)} of ${int(total)} send attempts. The provider call may or may not have gone out, so these are not counted as sent.` : "No send attempts in this window.",
  };
}

/**
 * Headline numbers for the selected window, taken from the same report the tables below show, so the two never
 * disagree. Each hint names the denominator. Definitions follow METRIC_DEFINITIONS.
 */
export function summaryItems(result: AnalyticsResult): SummaryItem[] {
  switch (result.view) {
    case "campaigns":
      return emailStyleSummary(result.data.totals);
    case "channels": {
      const total = result.data.channels.reduce(
        (sum, c) => ({
          contacted: sum.contacted + c.contacted,
          replied: sum.replied + c.replied,
          bounced: sum.bounced + c.bounced,
          sends: { sent: sum.sends.sent + c.sends.sent, unknown: sum.sends.unknown + c.sends.unknown, failed: sum.sends.failed + c.sends.failed, inFlight: sum.sends.inFlight + c.sends.inFlight },
        }),
        { contacted: 0, replied: 0, bounced: 0, sends: { sent: 0, unknown: 0, failed: 0, inFlight: 0 } },
      );
      return emailStyleSummary(total);
    }
    case "linkedin": {
      const { funnel, events } = result.data;
      const unknown = events.invites.unknown + events.messages.unknown;
      return [
        { label: "Invited", value: int(funnel.invited), hint: "People whose first confirmed invitation went out in this window." },
        { label: "Accepted", value: countWithRate(funnel.accepted, funnel.invited), hint: `${int(funnel.accepted)} of ${int(funnel.invited)} invited` },
        { label: "Messaged", value: countWithRate(funnel.messaged, funnel.accepted), hint: `${int(funnel.messaged)} of ${int(funnel.accepted)} accepted` },
        { label: "Replied", value: countWithRate(funnel.replied, funnel.accepted), hint: `${int(funnel.replied)} of ${int(funnel.accepted)} accepted` },
        unknownItem(unknown, { sent: events.invites.sent + events.messages.sent, unknown, failed: events.invites.failed + events.messages.failed, inFlight: events.invites.inFlight + events.messages.inFlight }),
      ];
    }
    case "replies": {
      const { total, byBucket, classifiedShare } = result.data;
      const pending = byBucket.find((b) => b.bucket === "pending_review")?.replies ?? 0;
      return [
        { label: "Replies", value: int(total), hint: "Inbound messages in this window from people who were contacted before the message arrived." },
        { label: "Classified", value: classifiedShare === null ? "-" : percent(classifiedShare), hint: `Replies with an applied classification, out of ${int(total)} replies.` },
        { label: "Pending review", value: int(pending), hint: "Replies whose latest classification is only proposed." },
      ];
    }
    case "timeseries": {
      const t = result.data.totals;
      return [
        { label: "Email sent", value: int(t.email_sent) },
        { label: "LinkedIn sent", value: int(t.linkedin_invites + t.linkedin_messages), hint: "Invitations and messages." },
        { label: "Replies", value: int(t.replies_email + t.replies_linkedin) },
        { label: "Unknown outcome", value: int(t.email_unknown + t.linkedin_unknown), hint: "Sends whose delivery nobody confirmed. Not counted as sent." },
      ];
    }
  }
}

function emailStyleSummary(t: { contacted: number; replied: number; bounced: number; sends: SendCounts }): SummaryItem[] {
  return [
    { label: "Contacted", value: int(t.contacted), hint: "People whose first confirmed send fell in this window, one per person and campaign." },
    { label: "Replied", value: countWithRate(t.replied, t.contacted), hint: `${int(t.replied)} of ${int(t.contacted)} contacted` },
    { label: "Bounced", value: countWithRate(t.bounced, t.contacted), hint: `${int(t.bounced)} of ${int(t.contacted)} contacted` },
    unknownItem(t.sends.unknown, t.sends),
  ];
}
