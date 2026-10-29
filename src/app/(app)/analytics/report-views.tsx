import { MailIcon, TriangleAlertIcon } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { cn } from "@/components/ui/utils";
import { EmptyState } from "@/components/shell/empty-state";
import { StatusBadge } from "@/components/shell/status-badge";
import { SummaryLine } from "@/components/shell/summary-line";
import { TouchTip } from "@/components/shell/touch-tip";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { AnalyticsResult } from "@/contexts/analytics/application/analytics-queries";
import {
  DAILY_METRICS,
  DAILY_METRIC_LABELS,
  METRIC_DEFINITIONS,
  type CampaignsReport,
  type ChannelsReport,
  type LinkedInReport,
  type RepliesReport,
  type SendCounts,
  type TimeSeriesReport,
} from "@/contexts/analytics/domain/metrics";
import { channelLabel } from "@/contexts/outreach/domain/campaign-view";
import { formatCount } from "@/shared/format-number";
import { LinkedInMark } from "@/app/(app)/_components/person/reach-icons";
import { SMALL_SAMPLE_BELOW, percent, rateDisplay, rateText, summaryItems } from "./report-format";

const NOBODY_CONTACTED = "Nobody contacted in this window";
const linkClass = "underline-offset-4 hover:underline focus-visible:underline";

/**
 * A rate over `whole` people. Zero people prints a dash that says why. A sample under SMALL_SAMPLE_BELOW prints
 * "1 of 2" in muted text, because 50.0% over two people claims more than the data holds.
 */
function Rate({ part, whole, none }: { part: number; whole: number; none: string }) {
  const rate = rateDisplay(part, whole);
  if (rate.kind === "empty") return <Why tip={none}>-</Why>;
  if (rate.kind === "fraction") {
    return (
      <Why tip={`Fewer than ${SMALL_SAMPLE_BELOW} people, so no percentage.`} className="text-muted-foreground">
        {rate.text}
      </Why>
    );
  }
  return <>{rate.text}</>;
}

/** A cell value whose reason sits in a tip on hover, focus and tap, and in screen-reader text after the value. */
function Why({ tip, className, children }: { tip: string; className?: string; children: ReactNode }) {
  return (
    <TouchTip trigger={<span tabIndex={0} className={cn("inline-flex items-center gap-1 rounded-sm focus-ring", className)} />} tip={tip}>
      {children}
      <span className="sr-only">{`. ${tip}`}</span>
    </TouchTip>
  );
}

/** The channel as a descriptor: its mark and its name in muted text, the way the Actions rows show it. */
function Channel({ channel }: { channel: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-muted-foreground [&_svg]:size-3.5">
      {channel === "linkedin" ? <LinkedInMark /> : <MailIcon aria-hidden />}
      {channelLabel(channel)}
    </span>
  );
}

/** Unknown-outcome sends are never part of "sent"; they get their own column and a warning icon, since the outcome is uncertain. */
function Unknown({ count, resolveHref }: { count: number; resolveHref?: string }) {
  if (count === 0) return <span className="text-muted-foreground">0</span>;
  const badge = (
    <Why tip="The provider call may or may not have gone out. Not counted as sent.">
      <TriangleAlertIcon aria-hidden className="size-3.5 text-warning" />
      {formatCount(count)}
    </Why>
  );
  if (!resolveHref) return badge;
  return (
    <span className="inline-flex items-center justify-end gap-2">
      {badge}
      <Link href={resolveHref} className={`text-xs ${linkClass}`}>
        Resolve in campaign
      </Link>
    </span>
  );
}

/** One report block. Blocks stack by section space with a hairline between them, not inside cards. */
const REPORT_BLOCK = "stack-group border-t pt-section first:border-t-0 first:pt-0";

function Empty({ title, view, filtered }: { title: string; view: string; filtered: boolean }) {
  return (
    <EmptyState
      title={title}
      description={filtered ? "Nothing matches these filters in this window." : "Nothing to count in this window."}
      action={filtered ? { label: "Clear filters", href: `/analytics?view=${view}` } : undefined}
    />
  );
}

function SendCells({ sends, resolveHref }: { sends: SendCounts; resolveHref?: string }) {
  return (
    <>
      <TableCell className="text-right tabular-nums">{formatCount(sends.sent)}</TableCell>
      <TableCell className="text-right tabular-nums">
        <Unknown count={sends.unknown} resolveHref={resolveHref} />
      </TableCell>
      <TableCell className="text-right tabular-nums">{formatCount(sends.failed)}</TableCell>
      <TableCell className="text-right tabular-nums">{formatCount(sends.inFlight)}</TableCell>
    </>
  );
}

const SendHeads = () => (
  <>
    <TableHead className="text-right">Sent</TableHead>
    <TableHead className="text-right">Unknown outcome</TableHead>
    <TableHead className="text-right">Failed</TableHead>
    <TableHead className="text-right">In flight</TableHead>
  </>
);

function CampaignsView({ report, filtered }: { report: CampaignsReport; filtered: boolean }) {
  if (report.rows.length === 0) return <Empty title="No campaigns" view="campaigns" filtered={filtered} />;
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Campaign</TableHead>
          <TableHead>Channel</TableHead>
          <TableHead className="text-right">Enrolled</TableHead>
          <TableHead className="text-right">Contacted</TableHead>
          <TableHead className="text-right">Replied</TableHead>
          <TableHead className="text-right">Reply rate</TableHead>
          <TableHead className="text-right">Bounced</TableHead>
          <TableHead className="text-right">Bounce rate</TableHead>
          <SendHeads />
        </TableRow>
      </TableHeader>
      <TableBody>
        {/* The totals row leads, so it stays in view above a long list of campaigns. */}
        {[report.totals, ...report.rows].map((c) => (
          <TableRow key={c.campaignId || "total"} className={c.campaignId ? undefined : "bg-muted/40 font-medium"}>
            <TableCell>
              {c.campaignId ? (
                <Link href={`/campaigns/${c.campaignId}`} className={`font-medium ${linkClass}`}>
                  {c.name}
                </Link>
              ) : (
                c.name
              )}
            </TableCell>
            <TableCell>{c.campaignId ? <Channel channel={c.channel} /> : null}</TableCell>
            <TableCell className="text-right tabular-nums">{formatCount(c.enrolled)}</TableCell>
            <TableCell className="text-right tabular-nums">{formatCount(c.contacted)}</TableCell>
            <TableCell className="text-right tabular-nums">{formatCount(c.replied)}</TableCell>
            <TableCell className="text-right tabular-nums">
              <Rate part={c.replied} whole={c.contacted} none={NOBODY_CONTACTED} />
            </TableCell>
            <TableCell className="text-right tabular-nums">{formatCount(c.bounced)}</TableCell>
            <TableCell className="text-right tabular-nums">
              <Rate part={c.bounced} whole={c.contacted} none={NOBODY_CONTACTED} />
            </TableCell>
            {/* Unconfirmed email sends are resolved on the campaign page. LinkedIn campaigns have no such panel. */}
            <SendCells sends={c.sends} resolveHref={c.campaignId && c.channel === "email" ? `/campaigns/${c.campaignId}` : undefined} />
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function ChannelsView({ report, filtered }: { report: ChannelsReport; filtered: boolean }) {
  return (
    <div className="stack-section">
      <section className={REPORT_BLOCK}>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Channel</TableHead>
              <TableHead className="text-right">Contacted</TableHead>
              <TableHead className="text-right">Replied</TableHead>
              <TableHead className="text-right">Reply rate</TableHead>
              <TableHead className="text-right">Bounced</TableHead>
              <SendHeads />
            </TableRow>
          </TableHeader>
          <TableBody>
            {report.channels.map((c) => (
              <TableRow key={c.channel}>
                <TableCell>{channelLabel(c.channel)}</TableCell>
                <TableCell className="text-right tabular-nums">{formatCount(c.contacted)}</TableCell>
                <TableCell className="text-right tabular-nums">{formatCount(c.replied)}</TableCell>
                <TableCell className="text-right tabular-nums">
                  <Rate part={c.replied} whole={c.contacted} none={NOBODY_CONTACTED} />
                </TableCell>
                <TableCell className="text-right tabular-nums">{formatCount(c.bounced)}</TableCell>
                <SendCells sends={c.sends} />
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </section>
      {report.senders.length === 0 ? (
        <Empty title="No sends by mailbox or account" view="channels" filtered={filtered} />
      ) : (
        <section className={REPORT_BLOCK}>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Mailbox or account</TableHead>
                <TableHead>Channel</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Contacted</TableHead>
                <SendHeads />
              </TableRow>
            </TableHeader>
            <TableBody>
              {report.senders.map((s) => (
                <TableRow key={`${s.channel}-${s.senderId}`}>
                  <TableCell>
                    <Link href={s.channel === "linkedin" ? "/settings/linkedin" : "/settings/mailboxes"} className={linkClass}>
                      {s.label}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <Channel channel={s.channel} />
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={s.status} />
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{formatCount(s.contacted)}</TableCell>
                  <SendCells sends={s.sends} />
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </section>
      )}
    </div>
  );
}

/** A bar's share of the whole, with a sliver for any value above zero so it never reads as nothing. */
const barWidth = (value: number, max: number) => `${max > 0 ? Math.max((value / max) * 100, value > 0 ? 1 : 0) : 0}%`;

/**
 * Bars of one series, so they stay grey (DESIGN.md Colors). The label and the number are the content and read as a
 * list; the bar repeats the number for the eye and is hidden from screen readers. `max` is the whole the bars share.
 */
function BarList({ label, max, bars }: { label: string; max: number; bars: Array<{ key: string; label: string; value: number }> }) {
  return (
    <ul aria-label={label} className="grid gap-2">
      {bars.map((b) => (
        <li key={b.key} className="grid grid-cols-[7rem_1fr_4rem] items-center gap-3 text-sm">
          <span>{b.label}</span>
          <span aria-hidden className="h-5 rounded bg-muted">
            <span className="block h-5 rounded bg-foreground/80" style={{ width: barWidth(b.value, max) }} />
          </span>
          <span className="text-right tabular-nums">{formatCount(b.value)}</span>
        </li>
      ))}
    </ul>
  );
}

function LinkedInView({ report }: { report: LinkedInReport }) {
  const f = report.funnel;
  return (
    <div className="stack-section">
      <section className={REPORT_BLOCK}>
        <div className="stack-field">
          <h2 className="heading-section">Funnel for people invited in this window</h2>
          <p className="text-sm text-muted-foreground">
            Acceptance {rateText(f.accepted, f.invited)} of invited. Messaged {rateText(f.messaged, f.accepted)} and replied {rateText(f.replied, f.accepted)} of accepted.
          </p>
        </div>
        <BarList
          label="LinkedIn funnel"
          max={f.invited}
          bars={[
            { key: "invited", label: "Invited", value: f.invited },
            { key: "accepted", label: "Accepted", value: f.accepted },
            { key: "messaged", label: "Messaged", value: f.messaged },
            { key: "replied", label: "Replied", value: f.replied },
          ]}
        />
      </section>

      <section className={REPORT_BLOCK}>
        <div className="stack-field">
          <h2 className="heading-section">Activity in this window</h2>
          <p className="text-sm text-muted-foreground">
            {formatCount(report.events.accepted)} connections accepted, {formatCount(report.events.replies)} replies received. Invitations and messages by outcome:
          </p>
        </div>
        <div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Type</TableHead>
                <SendHeads />
              </TableRow>
            </TableHeader>
            <TableBody>
              <TableRow>
                <TableCell>Invitations</TableCell>
                <SendCells sends={report.events.invites} />
              </TableRow>
              <TableRow>
                <TableCell>Messages</TableCell>
                <SendCells sends={report.events.messages} />
              </TableRow>
            </TableBody>
          </Table>
        </div>
      </section>

      {report.campaigns.length > 0 && (
        <section className={REPORT_BLOCK}>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Campaign</TableHead>
                <TableHead className="text-right">Invited</TableHead>
                <TableHead className="text-right">Accepted</TableHead>
                <TableHead className="text-right">Acceptance rate</TableHead>
                <TableHead className="text-right">Messaged</TableHead>
                <TableHead className="text-right">Replied</TableHead>
                <TableHead className="text-right">Reply rate</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {report.campaigns.map((c) => (
                <TableRow key={c.campaignId}>
                  <TableCell>
                    <Link href={`/campaigns/${c.campaignId}`} className={`font-medium ${linkClass}`}>
                      {c.name}
                    </Link>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{formatCount(c.invited)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatCount(c.accepted)}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    <Rate part={c.accepted} whole={c.invited} none="Nobody invited in this window" />
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{formatCount(c.messaged)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatCount(c.replied)}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    <Rate part={c.replied} whole={c.accepted} none="Nobody accepted in this window" />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </section>
      )}

      {report.accounts.length > 0 && (
        <section className={REPORT_BLOCK}>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Account</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Invites sent</TableHead>
                <TableHead className="text-right">Invites unknown</TableHead>
                <TableHead className="text-right">Accepted</TableHead>
                <TableHead className="text-right">Messages sent</TableHead>
                <TableHead className="text-right">Messages unknown</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {report.accounts.map((a) => (
                <TableRow key={a.accountId}>
                  <TableCell>
                    <Link href="/settings/linkedin" className={linkClass}>
                      {a.name}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={a.status} />
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{formatCount(a.invites.sent)}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    <Unknown count={a.invites.unknown} />
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{formatCount(a.accepted)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatCount(a.messages.sent)}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    <Unknown count={a.messages.unknown} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </section>
      )}
    </div>
  );
}

function RepliesView({ report, filtered }: { report: RepliesReport; filtered: boolean }) {
  if (report.total === 0 && !report.suppressions) return <Empty title="No replies" view="replies" filtered={filtered} />;
  return (
    <div className="stack-section">
      <section className={REPORT_BLOCK}>
        <div className="stack-field">
          <h2 className="heading-section">{formatCount(report.total)} replies</h2>
          <p className="text-sm text-muted-foreground">{report.classifiedShare === null ? "-" : percent(report.classifiedShare)} have an applied reply type.</p>
        </div>
        <BarList label="Replies by group" max={report.total} bars={report.byBucket.map((b) => ({ key: b.bucket, label: b.label, value: b.replies }))} />
      </section>
      <section className={REPORT_BLOCK}>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Channel</TableHead>
              <TableHead className="text-right">Replies</TableHead>
              {report.byBucket.map((b) => (
                <TableHead key={b.bucket} className="text-right">
                  {b.label}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {report.byChannel.map((c) => (
              <TableRow key={c.channel}>
                <TableCell>{channelLabel(c.channel)}</TableCell>
                <TableCell className="text-right tabular-nums">{formatCount(c.total)}</TableCell>
                {report.byBucket.map((b) => (
                  <TableCell key={b.bucket} className="text-right tabular-nums">
                    {formatCount(c.byBucket[b.bucket])}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </section>
      {report.byReplyType.length > 0 && (
        <section className={REPORT_BLOCK}>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Reply type</TableHead>
                <TableHead>Group</TableHead>
                <TableHead className="text-right">Replies</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {report.byReplyType.map((s) => (
                <TableRow key={`${s.bucket}-${s.name}`}>
                  <TableCell>{s.name}</TableCell>
                  <TableCell>{s.bucket.replace("_", " ")}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatCount(s.replies)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </section>
      )}
      {report.suppressions ? (
        <p className="text-sm text-muted-foreground">
          Suppressions added in this window: {formatCount(report.suppressions.unsubscribed)} unsubscribed, {formatCount(report.suppressions.bounced)} bounced, {formatCount(report.suppressions.complaint)} complaints, {formatCount(report.suppressions.manual)} manual.
        </p>
      ) : (
        <p className="text-sm text-muted-foreground">Suppressions belong to the organization, not a campaign, so they are hidden while a campaign filter is on.</p>
      )}
    </div>
  );
}

function TimeSeriesView({ report }: { report: TimeSeriesReport }) {
  const outbound = (p: TimeSeriesReport["points"][number]) => p.email_sent + p.linkedin_invites + p.linkedin_messages;
  const max = Math.max(1, ...report.points.map(outbound));
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Day</TableHead>
          <TableHead className="w-48">Sent</TableHead>
          {DAILY_METRICS.map((m) => (
            <TableHead key={m} className="text-right">
              {DAILY_METRIC_LABELS[m]}
            </TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {report.points.map((p) => (
          <TableRow key={p.day}>
            <TableCell className="tabular-nums">{p.day}</TableCell>
            <TableCell>
              {/* The bar is for the eye; the number beside it is what a screen reader hears. */}
              <div className="flex items-center gap-2">
                <span aria-hidden className="h-2 flex-1 rounded bg-muted">
                  <span className="block h-2 rounded bg-foreground/80" style={{ width: barWidth(outbound(p), max) }} />
                </span>
                <span className="w-12 text-right tabular-nums">{formatCount(outbound(p))}</span>
              </div>
            </TableCell>
            {DAILY_METRICS.map((m) => (
              <TableCell key={m} className="text-right tabular-nums">
                {p[m] === 0 ? <span className="text-muted-foreground">0</span> : m.endsWith("unknown") ? <Unknown count={p[m]} /> : formatCount(p[m])}
              </TableCell>
            ))}
          </TableRow>
        ))}
        <TableRow className="font-medium">
          <TableCell>Total</TableCell>
          <TableCell />
          {DAILY_METRICS.map((m) => (
            <TableCell key={m} className="text-right tabular-nums">
              {formatCount(report.totals[m])}
            </TableCell>
          ))}
        </TableRow>
      </TableBody>
    </Table>
  );
}

/** `filtered` is true when a campaign, account, archive or date filter is set, so the empty state can offer to clear it. */
export function AnalyticsReportView({ result, filtered }: { result: AnalyticsResult; filtered: boolean }) {
  return (
    <>
      <SummaryLine items={summaryItems(result)} />
      {result.view === "campaigns" && <CampaignsView report={result.data} filtered={filtered} />}
      {result.view === "channels" && <ChannelsView report={result.data} filtered={filtered} />}
      {result.view === "linkedin" && <LinkedInView report={result.data} />}
      {result.view === "replies" && <RepliesView report={result.data} filtered={filtered} />}
      {result.view === "timeseries" && <TimeSeriesView report={result.data} />}
      <details className="text-sm text-muted-foreground">
        <summary className="w-fit cursor-pointer rounded-sm focus-ring">How these numbers are counted</summary>
        <dl className="mt-2 grid gap-2">
          {METRIC_DEFINITIONS.map((m) => (
            <div key={m.key}>
              <dt className="inline font-medium text-foreground">{m.label}. </dt>
              <dd className="inline">{m.definition}</dd>
            </div>
          ))}
        </dl>
      </details>
    </>
  );
}
