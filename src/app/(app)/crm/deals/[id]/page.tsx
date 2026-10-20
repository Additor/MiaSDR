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
import { dealsDeps } from "@/contexts/deals/infrastructure/deals-composition";
import { requireOrgContext } from "@/contexts/identity/infrastructure/session";
import { leadContactPoints } from "@/contexts/leads/domain/lead-activity";
import { NO_REACH } from "@/contexts/outreach/domain/reachability";
import { readReachability } from "@/contexts/outreach/infrastructure/composition";
import { cn } from "@/lib/utils";
import { toActor } from "@/shared/api";
import { NotFoundError } from "@/shared/errors";
import { formatDate } from "@/shared/format-time";
import { dealDialogData } from "../../_components/deal-dialog-data";
import { DncControl } from "../../_components/person/dnc-control";
import { PersonActivity } from "../../_components/person/activity";
import { ReachIcons } from "../../_components/person/reach-icons";
import { stageVariant } from "../../_components/deals-list";
import { formatAmount, isOverdue, ownerText } from "../../pipeline/deal-format";
import { AsideSection, MetaLine, RecordBody, RecordHeader, RecordPage, RecordSection } from "../../_components/record/record-header";
import { dealReturnPath } from "../../_components/return-path";
import { DealActions } from "./deal-actions";

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
  const [dialog, conversation, zone, reachMap] = await Promise.all([
    dealDialogData(actor),
    personReplyHandling.activeConversationOfPerson(actor.organizationId, person.id),
    getOrgTimeZone(),
    readReachability(actor.organizationId, [person.id]),
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
                    {formatAmount(deal.amountMinor, deal.currency)}
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
                <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
                  <Fact label="Amount">{deal.amountMinor !== null && deal.currency ? <span className="tabular-nums">{formatAmount(deal.amountMinor, deal.currency)}</span> : "Not set"}</Fact>
                  <Fact label="Owner">{ownerText(deal.owner)}</Fact>
                  <Fact label="Expected close">
                    {deal.expectedCloseOn ? (
                      <span className={cn("tabular-nums", overdue && "font-medium")}>
                        {deal.expectedCloseOn}
                        {overdue && <span className="text-muted-foreground">, overdue</span>}
                      </span>
                    ) : (
                      "Not set"
                    )}
                  </Fact>
                  <Fact label="Source">
                    {deal.source ? (
                      <Link href={`/campaigns/${deal.source.campaignId}`} className="underline-offset-4 hover:underline">
                        From {deal.source.campaignName}
                      </Link>
                    ) : (
                      "No campaign"
                    )}
                  </Fact>
                  <Fact label="In this stage since">
                    <Time value={deal.stageChangedAt} />
                  </Fact>
                  {deal.closedAt && (
                    <Fact label={deal.stage.kind === "won" ? "Won" : "Lost"}>
                      <Time value={deal.closedAt} />
                    </Fact>
                  )}
                  {deal.lostReason && (
                    <Fact label="Lost reason" wide>
                      {deal.lostReason}
                    </Fact>
                  )}
                </dl>
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
                  <Link href={contactHref} className="font-medium underline-offset-4 hover:underline">
                    {contactName}
                  </Link>
                  {person.title && <span className="text-muted-foreground">{person.title}</span>}
                  <span className="break-all text-muted-foreground">{person.email ?? "No email"}</span>
                </div>
                <ReachIcons reach={reach} contact={leadContactPoints(person)} person={contactName} />
                <div className="flex flex-wrap gap-2">
                  <Link href={contactHref} className={buttonVariants({ variant: "outline", size: "sm" })}>
                    Open contact
                  </Link>
                  {conversation && (
                    <Link href={`/inbox/${conversation.conversationId}`} className={buttonVariants({ variant: "outline", size: "sm" })}>
                      Open conversation
                    </Link>
                  )}
                </div>
              </AsideSection>
              <AsideSection title="Do not contact" testId="deal-dnc">
                <DncControl personId={person.id} doNotContact={person.doNotContact} />
              </AsideSection>
              <AsideSection title="Company">
                {person.companyId ? (
                  <Link href={`/crm/companies/${person.companyId}`} className="text-sm underline-offset-4 hover:underline">
                    {person.companyName ?? "Company"}
                  </Link>
                ) : (
                  <p className="text-sm text-muted-foreground">No company</p>
                )}
              </AsideSection>
            </>
          }
        />
      </RecordPage>
    </>
  );
}

function Fact({ label, wide = false, children }: { label: string; wide?: boolean; children: React.ReactNode }) {
  return (
    <div className={cn("grid gap-0.5", wide && "sm:col-span-2")}>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  );
}
