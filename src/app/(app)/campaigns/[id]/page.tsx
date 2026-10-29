import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import { TriangleAlertIcon } from "lucide-react";
import { EmptyState } from "@/components/shell/empty-state";
import { PageHeader } from "@/components/shell/page-header";
import { Time } from "@/components/shell/time";
import { PageSkeleton } from "@/components/shell/page-skeleton";
import { ScrollableTable } from "@/components/ui/scrollable-table";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { requireOrgContext } from "@/contexts/identity/infrastructure/session";
import { getEmailRules } from "@/contexts/outreach/email/application/email-rules";
import { getCampaignDetail, getCampaignSenders } from "@/contexts/outreach/application/campaign-management";
import { isOwnerOrAdmin } from "@/contexts/tenancy/domain/roles";
import { enrollmentSelectionKey } from "@/contexts/outreach/domain/enrollment-list";
import { campaignLeadStatus } from "@/contexts/outreach/domain/campaign-lead-status";
import { stepsEditable, stepsWithPlaceholders, validateSteps } from "@/contexts/outreach/domain/campaign";
import { campaignSummary, leadsInProgress, parseCampaignTab, parseLeadsQuery, sendingRulesLine, startBlockers, startSummaryLines } from "@/contexts/outreach/domain/campaign-view";
import { getCampaignAfterReply } from "@/contexts/conversations/after-reply/application/after-reply";
import { afterReplyDeps } from "@/contexts/conversations/after-reply/infrastructure/sequence-composition";
import { campaignDeps, emailRulesDeps } from "@/contexts/outreach/infrastructure/composition";
import { toActor } from "@/app/_lib/api";
import { NotFoundError } from "@/shared/errors";
import { countOf } from "@/shared/format-number";
import { RecordPage } from "@/app/(app)/_components/record/record-header";
import { LeadStatusToken } from "@/app/(app)/_components/person/lead-status-token";
import { CampaignControls } from "./_components/campaign-controls";
import { CampaignHeader } from "./_components/campaign-header";
import { CampaignSection } from "./_components/campaign-section";
import { CampaignSenders } from "./_components/campaign-senders";
import { AfterReplyPanel } from "./_components/after-reply-panel";
import { CampaignTabs, SequenceNote } from "./_components/campaign-tabs";
import { LeadsSection } from "./_components/enroll-panel";
import { EnrollmentListFilters, EnrollmentPager } from "./_components/enrollment-list-controls";
import { canRemoveEnrollment } from "@/contexts/outreach/domain/enrollment-status";
import { EnrollmentSelectionProvider, RemoveRowButton, SelectAllRows, SelectRow } from "./_components/enrollment-remove";
import { LinkedInCampaignView } from "./_components/linkedin-campaign-view";
import { SendingRules } from "./_components/sending-rules";
import { StartBlockers } from "./_components/start-blockers";
import { StepsEditor } from "./_components/steps-editor";
import { UnconfirmedSends } from "./_components/unconfirmed-sends";

export const metadata: Metadata = { title: "Campaign" };

export default function CampaignPage({ params, searchParams }: PageProps<"/campaigns/[id]">) {
  return (
    <Suspense
      fallback={
        <div className="page">
          <PageSkeleton shape="record" />
        </div>
      }
    >
      <Campaign params={params} searchParams={searchParams} />
    </Suspense>
  );
}

async function Campaign({ params, searchParams }: { params: PageProps<"/campaigns/[id]">["params"]; searchParams: PageProps<"/campaigns/[id]">["searchParams"] }) {
  await connection();
  const { id } = await params;
  // A path that is not a UUID cannot match a row, and Postgres would reject it as a server error.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) notFound();
  const rawParams = await searchParams;
  const query = parseLeadsQuery(rawParams);
  const tab = parseCampaignTab(rawParams.tab);
  const actor = toActor(await requireOrgContext());

  let detail;
  try {
    detail = await getCampaignDetail(campaignDeps(), actor, id, query);
  } catch (error) {
    if (!(error instanceof NotFoundError)) throw error;
    // Not an email campaign of this organization: it may be a LinkedIn one.
    try {
      return await LinkedInCampaignView({ id, query, tab, actor });
    } catch (linkedinError) {
      if (linkedinError instanceof NotFoundError) notFound();
      throw linkedinError;
    }
  }
  const { campaign, enrollments, connectedMailboxes, waitingOnUnavailable, unconfirmed } = detail;
  const senders = await getCampaignSenders(campaignDeps(), actor, id);
  const needsRules = campaign.status === "draft" || waitingOnUnavailable > 0 || tab === "settings";
  const [rules, afterReply] = await Promise.all([
    needsRules ? getEmailRules(emailRulesDeps(), actor) : null,
    tab === "settings" ? getCampaignAfterReply(afterReplyDeps(), actor, id) : null,
  ]);
  const takeoverAfterHours = rules?.takeoverAfterHours ?? 24;
  const base = `/campaigns/${campaign.id}`;
  const everyone = enrollments.counts.all + enrollments.counts.removed;
  const blockers = startBlockers({
    channel: "email",
    status: campaign.status,
    leads: enrollments.counts.all,
    connectedSenders: connectedMailboxes,
    offlineAssigned: senders.assigned.filter((s) => !s.connected).map((s) => s.label),
    stepIssues: validateSteps(campaign.steps).length,
    placeholderSteps: stepsWithPlaceholders(campaign.steps),
  });
  const startLines = startSummaryLines({ channel: "email", leads: enrollments.counts.all, senders: senders.assigned.map((s) => s.label), gapMinutes: rules?.sendGapMinutes });

  const campaignScope = { status: campaign.status, name: campaign.name };

  return (
    <>
      <PageHeader title={campaign.name} titleAs="p" back={{ href: "/campaigns", label: "Campaigns" }} />
      <RecordPage>
        <CampaignHeader
          name={campaign.name}
          status={campaign.status}
          archived={campaign.archivedAt !== null}
          channel="email"
          steps={campaign.steps.length}
          senders={senders.assigned.map((s) => s.label)}
          summary={campaignSummary({ channel: "email", counts: enrollments.counts, sent: enrollments.sent })}
          actions={
            <CampaignControls
              id={campaign.id}
              name={campaign.name}
              status={campaign.status}
              archived={campaign.archivedAt !== null}
              blockers={blockers.map((b) => b.message)}
              startLines={startLines}
              inProgress={leadsInProgress(enrollments.counts)}
            />
          }
        />

        {(unconfirmed.total > 0 || waitingOnUnavailable > 0) && (
          <div>
            {unconfirmed.total > 0 && (
              <UnconfirmedSends
                campaignId={campaign.id}
                total={unconfirmed.total}
                canResolve={isOwnerOrAdmin(actor.role)}
                rows={unconfirmed.rows.map((r) => ({
                  sendId: r.sendId,
                  personName: r.personName,
                  email: r.email,
                  stepNumber: r.stepNumber,
                  mailboxEmail: r.mailboxEmail,
                  claimedAt: r.claimedAt.toISOString(),
                  note: r.note,
                }))}
              />
            )}
            {waitingOnUnavailable > 0 && (
              <CampaignSection
                testId="unavailable-mailbox"
                icon={<TriangleAlertIcon aria-hidden className="size-4 shrink-0 text-warning" />}
                title="Follow-ups waiting on an unavailable mailbox"
                description={
                  <>
                    {countOf(waitingOnUnavailable, "lead waits", "leads wait")} for follow-ups on a mailbox that is disabled or failed. After {countOf(takeoverAfterHours, "hour")} without
                    it, another mailbox takes over and the thread breaks.{" "}
                    <Link href="/settings/mailboxes" className="text-foreground underline underline-offset-4 focus-ring">
                      Open mailboxes
                    </Link>
                    .
                  </>
                }
              />
            )}
          </div>
        )}

        <StartBlockers blockers={blockers} channel="email" base={base} />

        <div className="stack-group">
          <CampaignTabs base={base} active={tab} />

          {tab === "leads" && (
            <LeadsSection id={campaign.id} count={enrollments.counts.all} disabled={campaign.status === "completed"}>
              {everyone === 0 ? (
                <EmptyState title="No leads yet" description="Use Add leads to pick the people this campaign contacts." />
              ) : (
                <>
                  <EnrollmentListFilters base={base} query={query} counts={enrollments.counts} campaignStatus={campaign.status} />
                  {enrollments.total === 0 ? (
                    <EmptyState title="No leads match this filter" description="Pick another status or clear the search." />
                  ) : (
                    <EnrollmentSelectionProvider key={enrollmentSelectionKey(campaign.id, query)} channel="email" campaignId={campaign.id}>
                      <ScrollableTable>
                        <Table>
                          <TableHeader>
                            <TableRow>
                              <TableHead className="w-8">
                                <SelectAllRows ids={enrollments.rows.filter((r) => canRemoveEnrollment(r.status)).map((r) => r.enrollmentId)} />
                              </TableHead>
                              <TableHead>Lead</TableHead>
                              <TableHead>Email</TableHead>
                              <TableHead>Status</TableHead>
                              <TableHead className="text-right">Step</TableHead>
                              <TableHead>Next email</TableHead>
                              <TableHead>Last sent</TableHead>
                              <TableHead className="w-28 min-w-28" />
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {enrollments.rows.map((row) => {
                              const status = campaignLeadStatus({ id: row.enrollmentId, ...row }, campaignScope);
                              return (
                                <TableRow key={row.enrollmentId}>
                                  <TableCell>
                                    <SelectRow id={row.enrollmentId} name={row.personName} disabled={!canRemoveEnrollment(row.status)} />
                                  </TableCell>
                                  <TableCell className="font-medium">
                                    <Link href={`/leads/${row.personId}`} className="underline-offset-4 focus-ring hover:underline">
                                      {row.personName ?? row.email ?? "Unnamed lead"}
                                    </Link>
                                    {row.inboxConversationId && (
                                      <Link href={`/inbox/${row.inboxConversationId}`} className="mt-0.5 block w-fit text-xs font-normal underline underline-offset-4 focus-ring" data-testid="inbox-thread-link">
                                        Open in Inbox
                                      </Link>
                                    )}
                                  </TableCell>
                                  <TableCell>{row.email}</TableCell>
                                  <TableCell>{status && <LeadStatusToken status={status} compact />}</TableCell>
                                  <TableCell className="text-right tabular-nums">
                                    {row.currentStep}/{campaign.steps.length}
                                  </TableCell>
                                  <TableCell className="text-muted-foreground">{row.nextSendAt && <Time value={row.nextSendAt} />}</TableCell>
                                  <TableCell className="text-muted-foreground">{row.lastSentAt && <Time value={row.lastSentAt} />}</TableCell>
                                  <TableCell className="min-w-28 text-right">
                                    <RemoveRowButton id={row.enrollmentId} name={row.personName} status={row.status} />
                                  </TableCell>
                                </TableRow>
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
            </LeadsSection>
          )}

          {tab === "sequence" && (
            <div className="stack-group">
              <SequenceNote />
              <StepsEditor id={campaign.id} initial={campaign.steps} editable={stepsEditable(campaign.status)} />
            </div>
          )}

          {tab === "settings" && afterReply && (
            <div>
              <CampaignSenders id={campaign.id} channel="email" options={senders.available} assigned={senders.assigned.map((s) => s.id)} />
              <SendingRules channel="email" line={sendingRulesLine({ channel: "email", gapMinutes: rules?.sendGapMinutes })} />
              <AfterReplyPanel view={afterReply} />
            </div>
          )}
        </div>
      </RecordPage>
    </>
  );
}
