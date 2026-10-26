import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import { getOrgTimeZone } from "@/components/shell/org-time-zone";
import { PageHeader } from "@/components/shell/page-header";
import { Time } from "@/components/shell/time";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { personReplyHandling } from "@/contexts/conversations/infrastructure/composition";
import { getDeal, type DealView } from "@/contexts/deals/application/deals";
import { dealsDeps } from "@/composition/deals";
import { requireOrgContext } from "@/contexts/identity/infrastructure/session";
import { getLead } from "@/contexts/people/application/lead-management";
import { leadContactPoints } from "@/contexts/people/domain/lead-activity";
import { leadDeps } from "@/contexts/people/infrastructure/composition";
import { NO_REACH } from "@/contexts/outreach/domain/reachability";
import { readReachability } from "@/contexts/outreach/infrastructure/composition";
import { toActor } from "@/app/_lib/api";
import { NotFoundError } from "@/shared/errors";
import { formatDate } from "@/shared/format-time";
import { dealDialogData } from "../../_components/deal-dialog-data";
import { DoNotContactCard } from "../../_components/person/do-not-contact-card";
import { PersonActivity } from "../../_components/person/activity";
import { ReachIcons } from "../../_components/person/reach-icons";
import { stageVariant } from "../../_components/deals-list";
import { moneyText } from "../../_components/money-text";
import { isOverdue, ownerText } from "../../pipeline/deal-format";
import { AsideSection, MetaLine, RecordBody, RecordHeader, RecordPage, RecordSection } from "../../_components/record/record-header";
import { dealReturnPath } from "../../_components/return-path";
import { DealActions } from "./deal-actions";
import { DealSummaryFields } from "./deal-summary";
import { Fact } from "../../_components/record/inline-field";

export const metadata: Metadata = { title: "Deal" };

const PIPELINE_BACK = { href: "/crm/pipeline", label: "Pipeline" };

export default function DealPage({ params, searchParams }: PageProps<"/crm/deals/[id]">) {
  return (
    <Suspense
      fallback={
        <>
          <PageHeader title="Deal" titleAs="p" back={PIPELINE_BACK} />
          <div className="page stack-section" data-testid="deal-loading" aria-busy="true">
            <Skeleton className="h-24 w-full" />
            <div className="grid gap-section lg:grid-cols-[minmax(0,1fr)_20rem] xl:grid-cols-[minmax(0,1fr)_22rem]">
              <Skeleton className="h-64 w-full" />
              <Skeleton className="h-72 w-full" />
            </div>
          </div>
        </>
      }
    >
      <Deal params={params} searchParams={searchParams} />
    </Suspense>
  );
}


async function Deal({ params, searchParams }: { params: PageProps<"/crm/deals/[id]">["params"]; searchParams: PageProps<"/crm/deals/[id]">["searchParams"] }) {
  await connection();
  const { id } = await params;
  // The page the link came from: the back link and the landing after a delete. Off the allowlist, Pipeline.
  const from = (await searchParams).from;
  const origin = dealReturnPath(Array.isArray(from) ? from[0] : from);
  const actor = toActor(await requireOrgContext());
  const deps = dealsDeps();
  let deal: DealView;
  try {
    deal = await getDeal(deps, actor, id);
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    throw error;
  }
  const { person } = deal;
  const [dialog, conversation, zone, reachMap, stop] = await Promise.all([
    dealDialogData(actor),
    personReplyHandling.activeConversationOfPerson(actor.organizationId, person.id),
    getOrgTimeZone(),
    readReachability(actor.organizationId, [person.id]),
    // The do not contact reason and date, and the suppression, for the stop block every person page ends with.
    getLead(leadDeps(), actor, person.id).then(
      (lead) => ({ policy: lead.policy, suppression: lead.suppression }),
      () => ({ policy: null, suppression: null }),
    ),
  ]);
  const reach = reachMap.get(person.id) ?? NO_REACH;
  const today = formatDate(deps.now(), zone);
  const overdue = isOverdue(deal.expectedCloseOn, today, deal.stage.kind);
  const contactName = person.name ?? person.email ?? "Unnamed contact";

  const contactHref = `/crm/contacts/${person.id}`;
  return (
    <>
      <PageHeader title={deal.title} titleAs="p" back={{ href: origin.path, label: origin.label }} />
      <RecordPage>
        <RecordHeader
          testId="deal-header"
          name={deal.title}
          subtitle={
            <>
              <Link href={contactHref} className="text-foreground underline-offset-4 hover:underline">
                {contactName}
              </Link>
              {person.companyName && (
                <>
                  {" at "}
                  {person.companyId ? (
                    <Link href={`/crm/companies/${person.companyId}`} className="text-foreground underline-offset-4 hover:underline">
                      {person.companyName}
                    </Link>
                  ) : (
                    person.companyName
                  )}
                </>
              )}
            </>
          }
          status={
            <MetaLine
              label="Deal status"
              items={[
                <Badge key="stage" variant={stageVariant(deal.stage.kind)} data-testid="deal-stage">
                  {deal.stage.name}
                </Badge>,
                overdue && <span key="overdue" className="font-medium text-foreground">Overdue</span>,
                <span key="owner">{ownerText(deal.owner)}</span>,
                deal.amountMinor !== null && deal.currency && (
                  <span key="amount" className="text-foreground tabular-nums">
                    {moneyText(deal.amountMinor, deal.currency)}
                  </span>
                ),
              ]}
            />
          }
          actions={
            <DealActions
              deal={{
                id: deal.id,
                title: deal.title,
                version: deal.version,
                stageId: deal.stage.id,
                stageKind: deal.stage.kind,
                ownerId: deal.owner?.userId ?? null,
                ownerIsMember: deal.owner?.isMember ?? false,
                amountMinor: deal.amountMinor,
                currency: deal.currency,
                expectedCloseOn: deal.expectedCloseOn,
              }}
              stages={dialog.stages}
              members={dialog.members}
              currentUserId={dialog.currentUserId}
              returnPath={origin.path}
            />
          }
        />
        <RecordBody
          asideLabel="Contact and company"
          main={
            <>
              <RecordSection title="Summary" testId="deal-summary">
                <dl className="grid max-w-xl gap-y-3 text-sm">
                  <DealSummaryFields
                    deal={{
                      id: deal.id,
                      version: deal.version,
                      amountMinor: deal.amountMinor,
                      currency: deal.currency,
                      amountText: moneyText(deal.amountMinor, deal.currency),
                      ownerId: deal.owner?.userId ?? null,
                      ownerIsMember: deal.owner?.isMember ?? false,
                      ownerText: ownerText(deal.owner),
                      expectedCloseOn: deal.expectedCloseOn,
                      overdue,
                    }}
                    members={dialog.members}
                    currentUserId={dialog.currentUserId}
                  />
                  {deal.lostReason && <Fact label="Lost reason">{deal.lostReason}</Fact>}
                </dl>
                <p className="text-xs text-muted-foreground" data-testid="deal-origin">
                  {deal.source ? (
                    <>
                      From{" "}
                      <Link href={`/campaigns/${deal.source.campaignId}`} className="underline underline-offset-4 hover:text-foreground">
                        {deal.source.campaignName}
                      </Link>
                      .{" "}
                    </>
                  ) : (
                    "No campaign. "
                  )}
                  In {deal.stage.name} since <Time value={deal.stageChangedAt} />.
                  {deal.closedAt && (
                    <>
                      {" "}
                      {deal.stage.kind === "won" ? "Won" : "Lost"} <Time value={deal.closedAt} />.
                    </>
                  )}
                </p>
              </RecordSection>
              <Suspense fallback={<Skeleton className="h-64 w-full" />}>
                <PersonActivity actor={actor} personId={person.id} first="tasks" />
              </Suspense>
            </>
          }
          aside={
            <>
              <AsideSection title="Contact" testId="deal-contact">
                <div className="grid gap-0.5 text-sm">
                  <Link href={contactHref} className="font-medium underline underline-offset-4">
                    {contactName}
                  </Link>
                  {(person.title || person.companyName) && (
                    <span className="text-muted-foreground">
                      {person.title}
                      {person.title && person.companyName && " at "}
                      {person.companyName &&
                        (person.companyId ? (
                          <Link href={`/crm/companies/${person.companyId}`} className="underline underline-offset-4 hover:text-foreground">
                            {person.companyName}
                          </Link>
                        ) : (
                          person.companyName
                        ))}
                    </span>
                  )}
                  <span className="[overflow-wrap:anywhere] text-muted-foreground">{person.email ?? "No email"}</span>
                </div>
                <ReachIcons reach={reach} contact={leadContactPoints(person)} person={contactName} />
                {conversation && (
                  <div>
                    <Link href={`/inbox/${conversation.conversationId}`} className={buttonVariants({ variant: "outline", size: "sm", className: "max-sm:h-11" })}>
                      Open conversation
                    </Link>
                  </div>
                )}
              </AsideSection>
              <DoNotContactCard
                personId={person.id}
                doNotContact={person.doNotContact}
                reason={stop.policy?.reason ?? null}
                setAt={stop.policy?.setAt ?? null}
                suppression={stop.suppression ? { reason: stop.suppression.reason, note: stop.suppression.note, date: stop.suppression.createdAt.toISOString() } : null}
                testId="deal-dnc"
              />
            </>
          }
        />
      </RecordPage>
    </>
  );
}
