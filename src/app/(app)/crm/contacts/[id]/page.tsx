import { ChevronRightIcon } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import { PageHeader } from "@/components/shell/page-header";
import { buttonVariants } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { contactDeleteDeps } from "@/composition/person-lifecycle";
import { personReplyHandling } from "@/contexts/conversations/infrastructure/composition";
import { dealSummaryForPeople, getDeal, isUuid } from "@/contexts/deals/application/deals";
import { primaryDeal } from "@/contexts/deals/domain/primary-deal";
import { dealsDeps } from "@/contexts/deals/infrastructure/deals-composition";
import { requireOrgContext } from "@/contexts/identity/infrastructure/session";
import { previewContactDelete } from "@/contexts/leads/application/contact-delete";
import { getLead } from "@/contexts/leads/application/lead-management";
import { telHref } from "@/contexts/leads/domain/lead-contact-links";
import { sourceLabel } from "@/contexts/leads/domain/lead-labels";
import { leadDeps } from "@/contexts/leads/infrastructure/composition";
import { readLeadActivity } from "@/contexts/outreach/application/read-lead-activity";
import { leadActivityDeps } from "@/contexts/outreach/infrastructure/composition";
import { toActor } from "@/shared/api";
import { NotFoundError, type Actor } from "@/shared/errors";
import { CreateDealButton } from "../../_components/create-deal-dialog";
import { dealDialogData } from "../../_components/deal-dialog-data";
import { dealHref } from "../../_components/deal-href";
import { DealsList } from "../../_components/deals-list";
import { CampaignsTable } from "../../_components/person/campaigns-table";
import { SendHistoryTable } from "../../_components/person/send-history-table";
import { SourceDataCard } from "../../_components/person/source-data-card";
import { PersonActivity } from "../../_components/person/activity";
import { DoNotContactCard } from "../../_components/person/do-not-contact-card";
import { PersonDetails } from "../../_components/person/person-details";
import { personDetailsFields } from "../../_components/person/person-fields";
import { ReachLinks } from "../../_components/person/reach-links";
import { RecordBody, RecordHeader, RecordPage, RecordSection } from "../../_components/record/record-header";
import { contactReturnPath } from "../../_components/return-path";
import type { DeletePreview } from "./contact-delete-copy";
import { ContactMoreMenu } from "./contact-delete";

export const metadata: Metadata = { title: "Contact" };

export default function ContactPage({ params, searchParams }: PageProps<"/crm/contacts/[id]">) {
  return (
    <Suspense fallback={<ContactSkeleton />}>
      <Contact params={params} searchParams={searchParams} />
    </Suspense>
  );
}

function ContactSkeleton() {
  return (
    <>
      <PageHeader title="Contact" titleAs="p" back={{ href: "/crm/contacts", label: "Contacts" }} />
      <RecordPage>
        <Skeleton className="h-32 w-full" aria-hidden />
        <RecordBody
          asideLabel="Contact details"
          main={
            <>
              <Skeleton className="h-40 w-full" aria-hidden />
              <Skeleton className="h-48 w-full" aria-hidden />
            </>
          }
          aside={<Skeleton className="h-64 w-full" aria-hidden />}
        />
      </RecordPage>
    </>
  );
}

const PanelSkeleton = () => <Skeleton className="h-40 w-full" />;

async function Contact({ params, searchParams }: { params: PageProps<"/crm/contacts/[id]">["params"]; searchParams: PageProps<"/crm/contacts/[id]">["searchParams"] }) {
  await connection();
  const { id } = await params;
  const from = (await searchParams).from;
  // Where a delete lands: the list or company page the contact was opened from.
  const returnTo = contactReturnPath(typeof from === "string" ? from : null);
  const actor = toActor(await requireOrgContext());

  let lead;
  try {
    // A malformed id cannot exist; the database would reject it with a cast error, so check first.
    if (!isUuid(id)) throw new NotFoundError();
    lead = await getLead(leadDeps(), actor, id);
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    throw error;
  }
  // A lead has its own page. Conversion goes one way, so a contact never comes back here.
  if (lead.person.lifecycle !== "contact") redirect(`/leads/${id}`);

  const deps = dealsDeps();
  const [summaries, people, conversation, dialog, activities, deletion] = await Promise.all([
    dealSummaryForPeople(deps, actor, [id]),
    deps.people.summaries(actor.organizationId, [id]),
    personReplyHandling.activeConversationOfPerson(actor.organizationId, id),
    dealDialogData(actor),
    readLeadActivity(leadActivityDeps(), actor.organizationId, [lead.person]),
    previewContactDelete(contactDeleteDeps, actor, id).catch((error: unknown) => {
      // Deleted between the two reads.
      if (error instanceof NotFoundError) notFound();
      throw error;
    }),
  ]);
  // `readLeadActivity` returns an entry for each id it was given; a contact's has no status.
  const { reach, contact } = activities.get(id)!;
  const summary = summaries.get(id) ?? { deals: [], openDeals: 0, latestDealId: null };
  const directory = people.get(id);
  const source = await sourceCampaign(actor, summary.deals);

  const { person, customColumns, policy, suppression, enrollments, sends } = lead;
  const name = person.fullName ?? person.email ?? "Contact";
  const doNotContact = policy?.doNotContact ?? false;
  const { values, customFields } = personDetailsFields({ person, customColumns });
  const toEntries = (raw: Record<string, unknown> | null) => Object.entries(raw ?? {}).map(([key, value]) => ({ key, value: typeof value === "string" ? value : JSON.stringify(value) }));
  const companyLabel = person.companyName ?? person.companyDomain;
  const convertedAt = person.convertedAt;
  const outreachCount = [
    `${enrollments.length} ${enrollments.length === 1 ? "campaign" : "campaigns"}`,
    `${sends.length} ${sends.length === 1 ? "send" : "sends"}`,
  ].join(", ");
  // The deal Open deal opens: the newest open one, else the newest, as in the Contacts list.
  const headDeal = primaryDeal(summary.deals);
  const companyHref = directory?.companyId ? `/crm/companies/${directory.companyId}` : null;
  const dealPerson = { id, name: person.fullName, email: person.email, companyName: person.companyName, doNotContact, suppressed: Boolean(suppression), openDeals: summary.openDeals };
  // The client row gets the preview as JSON: the blockers' `until` as ISO text.
  const deletePreview = JSON.parse(JSON.stringify(deletion)) as DeletePreview;

  return (
    <>
      <PageHeader title={name} titleAs="p" back={{ href: "/crm/contacts", label: "Contacts" }} />
      <RecordPage>
        <RecordHeader
          testId="contact-summary"
          name={name}
          subtitle={
            (person.title || companyLabel) && (
              <>
                {person.title}
                {person.title && companyLabel ? " at " : ""}
                {companyLabel &&
                  (companyHref ? (
                    <Link href={companyHref} className="text-foreground underline-offset-4 hover:underline">
                      {companyLabel}
                    </Link>
                  ) : (
                    companyLabel
                  ))}
              </>
            )
          }
          reach={<ReachLinks reach={reach} contact={contact} phone={person.phone} phoneHref={telHref(person.phone)} />}
          actions={
            <>
              {headDeal && (
                <Link href={dealHref(headDeal.id, `/crm/contacts/${id}`)} className={buttonVariants()}>
                  Open deal
                </Link>
              )}
              <CreateDealButton
                mode="contact"
                variant={headDeal ? "outline" : "default"}
                person={dealPerson}
                members={dialog.members}
                currentUserId={dialog.currentUserId}
                stages={dialog.stages}
              />
              {conversation && (
                <Link href={`/inbox/${conversation.conversationId}`} className={buttonVariants({ variant: "outline" })}>
                  Open conversation
                </Link>
              )}
              <ContactMoreMenu preview={deletePreview} returnTo={returnTo} />
            </>
          }
        />
        <RecordBody
          asideLabel="Contact details"
          main={
            <>
              <RecordSection title="Deals" count={summary.deals.length === 0 ? undefined : `${summary.openDeals} open of ${summary.deals.length}`} testId="contact-deals">
                {summary.deals.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No deals. Deleting a deal leaves the person a contact; use Create deal above for a new opportunity.</p>
                ) : (
                  <DealsList deals={summary.deals} />
                )}
              </RecordSection>

              <Suspense fallback={<PanelSkeleton />}>
                <PersonActivity actor={actor} personId={id} first="tasks" />
              </Suspense>

              <details data-testid="outreach-history" className="group border-t py-section">
                <summary className="flex min-h-7 cursor-pointer items-center gap-2 rounded-md outline-none select-none focus-visible:ring-2 focus-visible:ring-ring max-sm:min-h-11">
                  <ChevronRightIcon aria-hidden className="size-4 text-muted-foreground transition-transform group-open:rotate-90" />
                  <h2 className="text-sm font-semibold">Outreach history</h2>
                  <span className="text-sm text-muted-foreground tabular-nums">{outreachCount}</span>
                </summary>
                <div className="mt-2 grid">
                  <CampaignsTable enrollments={enrollments} level="h3" emptyText="This contact was in no campaign." />
                  <SendHistoryTable sends={sends} level="h3" emptyText="Nothing sent to this contact yet." />
                </div>
              </details>

              <SourceDataCard person={toEntries(person.raw)} company={toEntries(person.companyRaw)} companyName={person.companyName} />
            </>
          }
          aside={
            <>
              <PersonDetails
                // New key after each save, so the panel shows the normalized values the server stored.
                key={person.updatedAt.toISOString()}
                id={person.id}
                noun="contact"
                dealCount={summary.deals.length}
                values={values}
                customFields={customFields}
                facts={{
                  emailHref: contact.email?.href ?? null,
                  phoneHref: telHref(person.phone),
                  linkedinHref: contact.linkedin?.href ?? null,
                  companyHref,
                  contactSince: convertedAt?.toISOString() ?? null,
                  sourceCampaign: source ? { name: source.campaignName, href: `/campaigns/${source.campaignId}` } : null,
                  source: person.source ? sourceLabel(person.source) : null,
                  created: person.createdAt.toISOString(),
                  updated: person.updatedAt.toISOString(),
                }}
              />
              <DoNotContactCard
                personId={id}
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

/**
 * The source campaign in Details: the source of the deal that made the person a contact, which is the first one created. A later deal
 * has no source, and a personal campaign never shows (`getDeal` leaves it out).
 */
async function sourceCampaign(actor: Actor, deals: Array<{ id: string; createdAt: Date }>) {
  const firstDeal = [...deals].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id))[0];
  if (!firstDeal) return null;
  try {
    return (await getDeal(dealsDeps(), actor, firstDeal.id)).source;
  } catch (error) {
    // Deleted between the two reads: the page shows no source.
    if (error instanceof NotFoundError) return null;
    throw error;
  }
}
