import Link from "next/link";
import { Fragment } from "react";
import { EmptyState } from "@/components/shell/empty-state";
import { PageHeader } from "@/components/shell/page-header";
import { Time } from "@/components/shell/time";
import { ScrollableTable } from "@/components/ui/scrollable-table";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { Actor } from "@/shared/errors";
import { humanizeToken } from "@/shared/humanize";
import { getLinkedInCampaignDetail, getLinkedInCampaignSenders } from "@/contexts/outreach/linkedin/application/linkedin-campaigns";
import { canReadPersonalThread, privateThreadHref, stepsEditable } from "@/contexts/outreach/domain/campaign";
import { campaignLeadStatus } from "@/contexts/outreach/domain/campaign-lead-status";
import { isOwnerOrAdmin } from "@/contexts/tenancy/domain/roles";
import { enrollmentSelectionKey, type EnrollmentListQuery } from "@/contexts/outreach/domain/enrollment-list";
import { campaignSummary, enrollmentStatusLabel, leadsInProgress, sendingRulesLine, startBlockers, startSummaryLines, type CampaignTab } from "@/contexts/outreach/domain/campaign-view";
import { getCampaignAfterReply } from "@/contexts/conversations/after-reply/application/after-reply";
import { afterReplyDeps } from "@/contexts/conversations/after-reply/infrastructure/sequence-composition";
import { MAX_INVITE_ATTEMPTS, INVITE_NOTE_MAX, describeLinkedInProgress, validateLinkedInSteps } from "@/contexts/outreach/linkedin/domain/linkedin";
import { linkedinCampaignDeps } from "@/contexts/outreach/linkedin/infrastructure/linkedin-composition";
import { RecordPage } from "@/app/(app)/_components/record/record-header";
import { LeadStatusToken } from "@/app/(app)/_components/person/lead-status-token";
import { StateTip } from "@/app/(app)/_components/person/state-tip";
import { StatusBadge } from "@/components/shell/status-badge";
import { CampaignControls } from "./campaign-controls";
import { CampaignHeader } from "./campaign-header";
import { CampaignSection } from "./campaign-section";
import { CampaignSenders } from "./campaign-senders";
import { CrossCampaignSkipped } from "./cross-campaign-skipped";
import { AfterReplyPanel } from "./after-reply-panel";
import { CampaignTabs, SequenceNote } from "./campaign-tabs";
import { LeadsSection } from "./enroll-panel";
import { EnrollmentListFilters, EnrollmentPager } from "./enrollment-list-controls";
import { canRemoveEnrollment } from "@/contexts/outreach/domain/enrollment-status";
import { EnrollmentSelectionProvider, RemoveRowButton, SelectAllRows, SelectRow } from "./enrollment-remove";
import { LinkedInStepsEditor } from "./linkedin-steps-editor";
import { SendingRules } from "./sending-rules";
import { StartBlockers } from "./start-blockers";

// Same rule as the start check on the server: a [[bracketed]] starter placeholder left in a message body.
const PLACEHOLDER = /\[\[[^\]]*\]\]/;

/** Detail page of a LinkedIn campaign. Throws NotFoundError when the id is not a LinkedIn campaign of this organization. */
export async function LinkedInCampaignView({ id, query, tab, actor }: { id: string; query: EnrollmentListQuery; tab: CampaignTab; actor: Actor }) {
  const { campaign, enrollments, accounts, connectedAccounts } = await getLinkedInCampaignDetail(linkedinCampaignDeps(), actor, id, query);
  const senders = await getLinkedInCampaignSenders(linkedinCampaignDeps(), actor, id);
  const afterReply = tab === "settings" ? await getCampaignAfterReply(afterReplyDeps(), actor, id) : null;
  const everyone = enrollments.counts.all + enrollments.counts.removed;
  const base = `/campaigns/${campaign.id}`;
  const overCount = enrollments.rows.filter((r) => r.noteOverLimit).length;
  const personal = campaign.type === "personal";
  const sendingAccounts = accounts.filter((a) => (senders.assigned.length === 0 ? a.status === "connected" : senders.assigned.some((s) => s.id === a.id)));
  const blockers = startBlockers({
    channel: "linkedin",
    status: campaign.status,
    leads: enrollments.counts.all,
    connectedSenders: connectedAccounts,
    offlineAssigned: senders.assigned.filter((s) => !s.connected).map((s) => s.label),
    stepIssues: validateLinkedInSteps(campaign.steps).length,
    placeholderSteps: campaign.steps.filter((st) => PLACEHOLDER.test(st.body)).map((st) => st.stepNumber),
  });
  const inviteLimits = sendingAccounts.map((a) => ({ daily: a.dailyLimit, weekly: a.weeklyLimit }));
  const startLines = startSummaryLines({ channel: "linkedin", leads: enrollments.counts.all, senders: senders.assigned.map((s) => s.label), inviteLimits });
  const canReadThreads = campaign.type === "personal" && canReadPersonalThread({ isOwnerOrAdmin: isOwnerOrAdmin(actor.role), actorUserId: actor.userId, createdBy: campaign.createdBy });

  const campaignScope = { status: campaign.status, name: campaign.name };

  return (
    <>
      <PageHeader title={campaign.name} titleAs="p" back={{ href: "/campaigns", label: "Campaigns" }} />
      <RecordPage>
        <CampaignHeader
          name={campaign.name}
          status={campaign.status}
          archived={campaign.archivedAt !== null}
          channel="linkedin"
          personal={personal}
          steps={campaign.steps.length}
          senders={senders.assigned.map((s) => s.label)}
          summary={campaignSummary({ channel: "linkedin", counts: enrollments.counts, sent: enrollments.sent })}
          actions={
            <CampaignControls
              id={campaign.id}
              name={campaign.name}
              status={campaign.status}
              channel="linkedin"
              archived={campaign.archivedAt !== null}
              blockers={blockers.map((b) => b.message)}
              startLines={startLines}
              inProgress={leadsInProgress(enrollments.counts)}
            />
          }
        />

        {connectedAccounts === 0 && campaign.status !== "completed" && campaign.status !== "draft" && (
          <div>
            <CampaignSection
              role="alert"
              testId="no-linkedin-account"
              title="No LinkedIn account is connected"
              description={
                <>
                  Invitations and messages go out from a connected LinkedIn account, so this campaign cannot send.{" "}
                  <Link href="/settings/linkedin" className="text-foreground underline underline-offset-4">
                    Connect one in Settings
                  </Link>
                  .
                </>
              }
            />
          </div>
        )}

        <StartBlockers blockers={blockers} channel="linkedin" base={base} />

        <div className="stack-group">
          <CampaignTabs base={base} active={tab} />

          {tab === "leads" && (
            <LeadsSection id={campaign.id} count={enrollments.counts.all} disabled={campaign.status === "completed"} channel="linkedin">
              {everyone === 0 ? (
                <EmptyState title="No leads yet" description="Use Add leads to pick the people this campaign contacts." />
              ) : (
                <>
                  <EnrollmentListFilters base={base} query={query} counts={enrollments.counts} campaignStatus={campaign.status} />
                  {overCount > 0 && (
                    <p role="status" className="text-sm text-destructive">
                      {overCount} lead{overCount === 1 ? "" : "s"} on this page {overCount === 1 ? "has" : "have"} an invitation note over {INVITE_NOTE_MAX} characters after merge fields. Starting is still allowed, and those invitations fail when they go out.
                    </p>
                  )}
                  {enrollments.total === 0 ? (
                    <EmptyState title="No leads match this filter" description="Pick another status or clear the search." />
                  ) : (
                    <EnrollmentSelectionProvider key={enrollmentSelectionKey(campaign.id, query)} channel="linkedin" campaignId={campaign.id}>
                      <ScrollableTable>
                        <Table>
                          <TableHeader>
                            <TableRow>
                              <TableHead className="w-8">
                                <SelectAllRows ids={enrollments.rows.filter((r) => canRemoveEnrollment(r.status)).map((r) => r.enrollmentId)} />
                              </TableHead>
                              <TableHead>Lead</TableHead>
                              <TableHead>Status</TableHead>
                              <TableHead className="text-right">Step</TableHead>
                              <TableHead className="text-right">Note length</TableHead>
                              <TableHead>Next action</TableHead>
                              <TableHead>Last sent</TableHead>
                              <TableHead className="w-28 min-w-28" />
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {enrollments.rows.map((row) => {
                              const status = campaignLeadStatus({ id: row.enrollmentId, ...row }, campaignScope);
                              const progress = describeLinkedInProgress({
                                status: row.status,
                                connectionState: row.connectionState,
                                currentStep: row.currentStep,
                                totalSteps: campaign.steps.length,
                                stopReason: row.stopReason,
                              });
                              const threadHref = privateThreadHref({ base, enrollmentId: row.enrollmentId, canRead: canReadThreads, hasPrivateThread: row.hasPrivateThread });
                              return (
                                <Fragment key={row.enrollmentId}>
                                  <TableRow>
                                    <TableCell>
                                      <SelectRow id={row.enrollmentId} name={row.personName} disabled={!canRemoveEnrollment(row.status)} />
                                    </TableCell>
                                    <TableCell className="font-medium">
                                      <Link href={`/leads/${row.personId}`} className="underline-offset-4 focus-ring hover:underline">
                                        {row.personName ?? row.profileUrl ?? "Unnamed lead"}
                                      </Link>
                                      {row.profileUrl && (
                                        <a href={row.profileUrl} target="_blank" rel="noreferrer" className="mt-0.5 block w-fit text-xs font-normal underline underline-offset-4 focus-ring">
                                          LinkedIn profile
                                        </a>
                                      )}
                                      {!personal && row.inboxConversationId && (
                                        <Link href={`/inbox/${row.inboxConversationId}`} className="mt-0.5 block w-fit text-xs font-normal underline underline-offset-4 focus-ring" data-testid="inbox-thread-link">
                                          Open in Inbox
                                        </Link>
                                      )}
                                      {threadHref && (
                                        <Link href={threadHref} className="mt-0.5 block w-fit text-xs font-normal underline underline-offset-4 focus-ring" data-testid="private-thread-link">
                                          Read the reply
                                        </Link>
                                      )}
                                    </TableCell>
                                    <TableCell className="max-w-64 whitespace-normal">
                                      <div className="stack-field">
                                        {status && <LeadStatusToken status={status} compact />}
                                        {/* The LinkedIn step (invitation sent, connected) the lead status does not name. */}
                                        <span className="text-xs text-muted-foreground" data-testid="linkedin-progress">
                                          {progress.detail}
                                        </span>
                                      </div>
                                    </TableCell>
                                    <TableCell className="text-right tabular-nums">
                                      {row.currentStep}/{campaign.steps.length}
                                    </TableCell>
                                    <TableCell className="text-right tabular-nums" data-testid="note-length">
                                      {row.noteLength === null ? (
                                        <span className="text-muted-foreground">-</span>
                                      ) : row.noteOverLimit ? (
                                        <StateTip
                                          trigger={<span tabIndex={0} className="rounded-sm text-destructive focus-ring" />}
                                          tip={`LinkedIn allows ${INVITE_NOTE_MAX} characters. This invitation fails when it goes out. Shorten the note, or fix the lead's fields.`}
                                        >
                                          {row.noteLength}/{INVITE_NOTE_MAX} over limit
                                        </StateTip>
                                      ) : (
                                        <span>
                                          {row.noteLength}/{INVITE_NOTE_MAX}
                                        </span>
                                      )}
                                    </TableCell>
                                    <TableCell className="text-muted-foreground">{row.nextSendAt && <Time value={row.nextSendAt} />}</TableCell>
                                    <TableCell className="text-muted-foreground">{row.lastSentAt && <Time value={row.lastSentAt} />}</TableCell>
                                    <TableCell className="min-w-28 text-right">
                                      <RemoveRowButton id={row.enrollmentId} name={row.personName} status={row.status} />
                                    </TableCell>
                                  </TableRow>
                                  <TableRow data-testid="lead-panel">
                                    <TableCell colSpan={8} className="py-0">
                                      <LeadPanel row={row} totalSteps={campaign.steps.length} threadHref={threadHref} />
                                    </TableCell>
                                  </TableRow>
                                </Fragment>
                              );
                            })}
                          </TableBody>
                        </Table>
                      </ScrollableTable>
                    </EnrollmentSelectionProvider>
                  )}
                  <EnrollmentPager base={base} query={query} total={enrollments.total} />
                </>
              )}
              <CrossCampaignSkipped actor={actor} campaignId={campaign.id} />
            </LeadsSection>
          )}

          {tab === "sequence" && (
            <div className="stack-group">
              <SequenceNote />
              <LinkedInStepsEditor id={campaign.id} initial={campaign.steps} editable={stepsEditable(campaign.status)} />
            </div>
          )}

          {tab === "settings" && afterReply && (
            <div>
              <CampaignSenders id={campaign.id} channel="linkedin" options={senders.available} assigned={senders.assigned.map((s) => s.id)} />
              <SendingRules channel="linkedin" line={sendingRulesLine({ channel: "linkedin", inviteLimits })} />
              {accounts.length > 0 && (
                <CampaignSection
                  title="Sending limits"
                  testId="sending-limits"
                  description="Connection requests only. Messages to people who accepted do not count. Today follows each account's time zone."
                >
                  <ul className="min-w-0 divide-y border-y text-sm">
                    {accounts.map((a) => (
                      <li key={a.id} className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1 py-2">
                        <span className="min-w-0 font-medium break-words">{a.name ?? a.username ?? "LinkedIn account"}</span>
                        <StatusBadge status={a.status} label={humanizeToken(a.status)} />
                        <span className="tabular-nums">
                          Today {a.invitesToday}/{a.dailyLimit}
                        </span>
                        <span className="tabular-nums">
                          Last 7 days {a.invitesThisWeek}/{a.weeklyLimit}
                        </span>
                        {a.limitReachedUntil && (
                          <span className="text-destructive">
                            LinkedIn limit reached, paused until <Time value={a.limitReachedUntil} />
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                </CampaignSection>
              )}
              <AfterReplyPanel view={afterReply} personal={personal} />
            </div>
          )}
        </div>
      </RecordPage>
    </>
  );
}

type PanelRow = Awaited<ReturnType<typeof getLinkedInCampaignDetail>>["enrollments"]["rows"][number];

/** Per-lead panel: messages sent, retries, last error, step and account. Collapsed by default. */
function LeadPanel({ row, totalSteps, threadHref }: { row: PanelRow; totalSteps: number; threadHref: string | null }) {
  const { detail } = row;
  const sent = detail.sends.filter((s) => s.status === "sent");
  return (
    <details className="text-sm">
      <summary className="w-fit cursor-pointer rounded-sm py-1 text-xs text-muted-foreground focus-ring">
        Details: {sent.length} sent, retries {detail.retries} of {MAX_INVITE_ATTEMPTS}
        {detail.lastError ? ", has an error" : ""}
      </summary>
      <div className="grid gap-1 pb-3">
        <p>
          <span className="text-muted-foreground">Headline:</span> {detail.headline ?? "-"}
          <span className="ml-4 text-muted-foreground">Company:</span> {detail.companyName ?? "-"}
        </p>
        <p>
          <span className="text-muted-foreground">Step:</span> {row.currentStep}/{totalSteps}
          <span className="ml-4 text-muted-foreground">Account:</span> {detail.accountName ?? "not assigned yet"}
          <span className="ml-4 text-muted-foreground">Messages sent:</span> {sent.length}
          <span className="ml-4 text-muted-foreground">Retries:</span> {detail.retries} of {MAX_INVITE_ATTEMPTS}
        </p>
        {threadHref && (
          <p>
            <Link href={threadHref} className="underline underline-offset-4 focus-ring">
              Read the reply
            </Link>{" "}
            <span className="text-xs text-muted-foreground">(private: not shown in the Inbox)</span>
          </p>
        )}
        {detail.lastError && (
          <p className="text-destructive">
            <span className="text-muted-foreground">Last error:</span> {detail.lastError}
          </p>
        )}
        {detail.alsoInCampaigns.length > 0 && (
          <p data-testid="also-in-campaigns">
            <span className="text-muted-foreground">Also in campaigns:</span>{" "}
            {detail.alsoInCampaigns.map((c, i) => (
              <Fragment key={c.campaignId}>
                {i > 0 && ", "}
                <Link href={`/campaigns/${c.campaignId}`} className="underline underline-offset-4 focus-ring">
                  {c.campaignName}
                </Link>{" "}
                <span className="text-xs text-muted-foreground">({enrollmentStatusLabel(c.status)})</span>
              </Fragment>
            ))}
          </p>
        )}
        {detail.excludedAccounts.length > 0 && (
          <p data-testid="excluded-accounts">
            <span className="text-muted-foreground">Already invited from:</span> {detail.excludedAccounts.map((a) => `${a.accountName ?? "a LinkedIn account"}${a.campaignName ? ` (${a.campaignName})` : ""}`).join(", ")}
            <span className="ml-2 text-xs text-muted-foreground">Those accounts do not invite this person again.</span>
          </p>
        )}
        {detail.sends.length > 0 && (
          <ul className="grid gap-1">
            {detail.sends.map((s) => (
              <li key={s.stepNumber}>
                <span className="tabular-nums text-muted-foreground">
                  Step {s.stepNumber}, {humanizeToken(s.status).toLowerCase()}
                  {s.sentAt && (
                    <>
                      , <Time value={s.sentAt} />
                    </>
                  )}
                  :
                </span>{" "}
                {s.body ?? ""}
              </li>
            ))}
          </ul>
        )}
      </div>
    </details>
  );
}
