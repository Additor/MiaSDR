import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import { PageHeader } from "@/components/shell/page-header";
import { buttonVariants } from "@/components/ui/button";
import { ListSkeleton } from "@/components/shell/list-skeleton";
import { PageSkeleton } from "@/components/shell/page-skeleton";
import { requireOrgContext } from "@/contexts/identity/infrastructure/session";
import { checkLeadDelete } from "@/contexts/people/application/lead-delete-check";
import { getLead } from "@/contexts/people/application/lead-management";
import { telHref } from "@/contexts/people/domain/lead-contact-links";
import { sourceLabel } from "@/contexts/people/domain/lead-labels";
import { leadDeps } from "@/contexts/people/infrastructure/composition";
import { leadDeleteDeps } from "@/composition/person-lifecycle";
import { readLeadNeighbors, type LeadNeighbors } from "@/contexts/people/infrastructure/composition";
import { readLeadActivity } from "@/contexts/outreach/application/read-lead-activity";
import { leadActivityDeps, crossCampaignNotices } from "@/contexts/outreach/infrastructure/composition";
import { toActor } from "@/app/_lib/api";
import { NotFoundError } from "@/shared/errors";
import { AddLeadToCampaign } from "../_components/add-to-campaign";
import { CampaignsTable } from "@/app/(app)/_components/person/campaigns-table";
import { SendHistoryTable } from "@/app/(app)/_components/person/send-history-table";
import { LeadNav } from "./lead-header";
import { LeadMoreMenu } from "./lead-more-menu";
import { backToListHref, neighborHref, parseListContext, LIST_PARAM } from "./list-context";
import { SourceDataCard } from "@/app/(app)/_components/person/source-data-card";
import { PersonActivity } from "@/app/(app)/_components/person/activity";
import { DoNotContactCard } from "@/app/(app)/_components/person/do-not-contact-card";
import { PersonDetails } from "@/app/(app)/_components/person/person-details";
import { LeadStatusToken } from "@/app/(app)/_components/person/lead-status-token";
import { personDetailsFields } from "@/app/(app)/_components/person/person-fields";
import { ReachLinks } from "@/app/(app)/_components/person/reach-links";
import { RecordBody, RecordHeader, RecordPage } from "@/app/(app)/_components/record/record-header";
import { CreateDealButton } from "../../crm/_components/create-deal-dialog";
import { dealDialogData } from "../../crm/_components/deal-dialog-data";

export const metadata: Metadata = { title: "Lead" };

export default function LeadPage({ params, searchParams }: PageProps<"/leads/[id]">) {
  return (
    <Suspense
      fallback={
        <div className="page">
          <PageSkeleton shape="record" />
        </div>
      }
    >
      <Lead params={params} searchParams={searchParams} />
    </Suspense>
  );
}

/** The lead page spans every campaign, so no campaign is left out of the context lookup. */
const NO_CAMPAIGN = "00000000-0000-0000-0000-000000000000";

async function Lead({ params, searchParams }: { params: PageProps<"/leads/[id]">["params"]; searchParams: PageProps<"/leads/[id]">["searchParams"] }) {
  await connection();
  const { id } = await params;
  const context = parseListContext((await searchParams)[LIST_PARAM]);
  const actor = toActor(await requireOrgContext());

  let lead;
  let nearby: LeadNeighbors | null = null;
  try {
    // A malformed id cannot exist; the database would reject it with a cast error, so check first.
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new NotFoundError();
    const neighbors: Promise<LeadNeighbors | null> = context ? readLeadNeighbors(actor.organizationId, id, context) : Promise.resolve(null);
    [lead, nearby] = await Promise.all([getLead(leadDeps(), actor, id), neighbors]);
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    throw error;
  }
  // A contact lives in the CRM. The page streams after `connection()`, so this is a client redirect behind a 200.
  if (lead.person.lifecycle === "contact") redirect(`/crm/contacts/${id}`);
  const { person, customColumns, policy, suppression, enrollments, sends, hiddenSends, conversationId } = lead;
  // The same read as the lead list, so the header and the list show one state.
  const [activities, deals] = await Promise.all([
    readLeadActivity(leadActivityDeps(), actor.organizationId, [person]),
    dealDialogData(actor),
  ]);
  // `readLeadActivity` returns an entry for each id it was given.
  const activity = activities.get(person.id)!;
  // Accounts that already invited this person: they do not invite them again from any campaign.
  const invitedFrom = (await crossCampaignNotices.leadContext(actor.organizationId, NO_CAMPAIGN, [person.id])).get(person.id)?.excludedAccounts ?? [];
  const { values, customFields } = personDetailsFields({ person, customColumns });
  const toEntries = (raw: Record<string, unknown> | null) =>
    Object.entries(raw ?? {}).map(([key, value]) => ({ key, value: typeof value === "string" ? value : JSON.stringify(value) }));
  const title = person.fullName ?? person.email ?? "Lead";
  const doNotContact = policy?.doNotContact ?? false;
  const qualification = await checkLeadDelete(leadDeleteDeps, actor, person.id);
  const listHref = backToListHref(context);
  const prevHref = context ? neighborHref(nearby?.prevId ?? null, context) : null;
  const nextHref = context ? neighborHref(nearby?.nextId ?? null, context) : null;

  const headline = [person.title, person.companyName ?? person.companyDomain].filter(Boolean).join(" at ");
  // The status picks the one filled action. A reply leads to the conversation; a lead in no live campaign leads to Add to
  // campaign; a lead the sequence is working has none, since the status token and Next carry the page. Do not contact
  // leaves campaigns out.
  const state = activity.status?.state ?? "new";
  const primary = state === "replied" && conversationId ? "conversation" : !doNotContact && ["new", "finished", "stopped"].includes(state) ? "campaign" : null;

  return (
    <>
      <PageHeader title={title} titleAs="p" back={{ href: listHref, label: "Leads" }} actions={context && (prevHref || nextHref) ? <LeadNav prevHref={prevHref} nextHref={nextHref} /> : undefined} />
      <RecordPage>
        <RecordHeader
          testId="lead-header"
          name={title}
          subtitle={headline || undefined}
          state={activity.status && <LeadStatusToken status={activity.status} />}
          reach={<ReachLinks reach={activity.reach} contact={activity.contact} phone={person.phone} phoneHref={telHref(person.phone)} />}
          actions={
            <>
              {primary === "campaign" && <AddLeadToCampaign personId={person.id} variant="default" />}
              {conversationId && (
                <Link href={`/inbox/${conversationId}`} className={buttonVariants({ variant: primary === "conversation" ? "default" : "outline" })}>
                  Open conversation
                </Link>
              )}
              <CreateDealButton
                mode="lead"
                variant="outline"
                person={{ id: person.id, name: person.fullName, email: person.email, companyName: person.companyName, doNotContact, suppressed: suppression !== null }}
                stages={deals.stages}
                members={deals.members}
                currentUserId={deals.currentUserId}
              />
              <LeadMoreMenu id={person.id} name={title} qualification={qualification} returnTo={listHref} addToCampaign={primary !== "campaign" && !doNotContact} />
            </>
          }
        />
        <RecordBody
          asideLabel="Lead details"
          main={
            <>
              <CampaignsTable enrollments={enrollments} invitedFrom={invitedFrom} />
              <SendHistoryTable sends={sends} hiddenSends={hiddenSends} />
              <Suspense fallback={<ListSkeleton rows={3} toolbar={false} label="Loading activity" />}>
                <PersonActivity actor={actor} personId={person.id} />
              </Suspense>
              <SourceDataCard person={toEntries(person.raw)} company={toEntries(person.companyRaw)} companyName={person.companyName} />
            </>
          }
          aside={
            <>
              <PersonDetails
                // New key after each save, so the panel shows the normalized values the server stored.
                key={person.updatedAt.toISOString()}
                id={person.id}
                noun="lead"
                values={values}
                customFields={customFields}
                facts={{
                  emailHref: activity.contact.email?.href ?? null,
                  phoneHref: telHref(person.phone),
                  linkedinHref: activity.contact.linkedin?.href ?? null,
                  companyHref: null,
                  source: person.source ? sourceLabel(person.source) : null,
                  created: person.createdAt.toISOString(),
                  updated: person.updatedAt.toISOString(),
                }}
              />
              <DoNotContactCard
                personId={person.id}
                doNotContact={doNotContact}
                reason={policy?.reason ?? null}
                setAt={policy?.setAt?.toISOString() ?? null}
                suppression={suppression ? { reason: suppression.reason, note: suppression.note, date: suppression.createdAt.toISOString() } : null}
              />
            </>
          }
        />
      </RecordPage>
    </>
  );
}
