import type { CampaignsReport, ChannelsReport, LinkedInReport, RepliesReport, TimeSeriesReport } from "./metrics";
import { DAILY_METRICS, DAILY_METRIC_LABELS } from "./metrics";

export type Cell = string | number | null;
export interface Table {
  headers: string[];
  rows: Cell[][];
}

/** A cell that starts with = + - @ or a control character runs as a formula in spreadsheets. A leading quote defuses it. */
function cell(value: Cell): string {
  if (value === null) return "";
  let text = String(value);
  if (typeof value === "string" && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(table: Table): string {
  return [table.headers, ...table.rows].map((row) => row.map(cell).join(",")).join("\r\n") + "\r\n";
}

const pct = (v: number | null): Cell => (v === null ? null : Math.round(v * 10_000) / 100);

export function campaignsTable(r: CampaignsReport): Table {
  return {
    headers: ["Campaign", "Channel", "Status", "Enrolled", "Contacted", "Replied", "Bounced", "Reply rate %", "Bounce rate %", "Sent", "Unknown outcome", "Failed", "In flight"],
    rows: [...r.rows, r.totals].map((c) => [c.name, c.campaignId ? c.channel : "", c.status, c.enrolled, c.contacted, c.replied, c.bounced, pct(c.replyRate), pct(c.bounceRate), c.sends.sent, c.sends.unknown, c.sends.failed, c.sends.inFlight]),
  };
}

export function channelsTable(r: ChannelsReport): Table {
  return {
    headers: ["Scope", "Channel", "Sender", "Contacted", "Replied", "Bounced", "Reply rate %", "Sent", "Unknown outcome", "Failed", "In flight"],
    rows: [
      ...r.channels.map((c): Cell[] => ["channel", c.channel, "", c.contacted, c.replied, c.bounced, pct(c.replyRate), c.sends.sent, c.sends.unknown, c.sends.failed, c.sends.inFlight]),
      ...r.senders.map((s): Cell[] => ["sender", s.channel, s.label, s.contacted, null, null, null, s.sends.sent, s.sends.unknown, s.sends.failed, s.sends.inFlight]),
    ],
  };
}

export function linkedinTable(r: LinkedInReport): Table {
  return {
    headers: ["Campaign", "Invited", "Accepted", "Messaged", "Replied", "Acceptance rate %", "Reply rate %"],
    rows: [
      ...r.campaigns.map((c): Cell[] => [c.name, c.invited, c.accepted, c.messaged, c.replied, pct(c.acceptanceRate), pct(c.replyRate)]),
      ["All campaigns", r.funnel.invited, r.funnel.accepted, r.funnel.messaged, r.funnel.replied, pct(r.funnel.acceptanceRate), pct(r.funnel.replyRate)],
    ],
  };
}

export function repliesTable(r: RepliesReport): Table {
  return {
    headers: ["Category", "Replies", "Share %"],
    rows: [...r.byBucket.map((b): Cell[] => [b.label, b.replies, pct(b.share)]), ["Total", r.total, null]],
  };
}

export function timeSeriesTable(r: TimeSeriesReport): Table {
  return {
    headers: ["Day", ...DAILY_METRICS.map((m) => DAILY_METRIC_LABELS[m])],
    rows: r.points.map((p) => [p.day, ...DAILY_METRICS.map((m) => p[m])]),
  };
}
