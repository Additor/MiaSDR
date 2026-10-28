import { ExternalLinkIcon } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import { EmptyState } from "@/components/shell/empty-state";
import { PageHeader } from "@/components/shell/page-header";
import { RowLink, rowLinkClasses } from "@/components/shell/row-link";
import { Time } from "@/components/shell/time";
import { buttonVariants } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { personReplyHandling } from "@/contexts/conversations/infrastructure/composition";
import type { ContactListRow } from "@/contexts/deals/application/deal-ports";
import { getCompany } from "@/contexts/deals/application/deals";
import { dealsDeps } from "@/composition/deals";
import { requireOrgContext } from "@/contexts/identity/infrastructure/session";
import { companyInUseMessage } from "@/contexts/people/application/company-lifecycle";
import { listCustomColumns } from "@/contexts/people/application/custom-columns";
import { customColumnStore } from "@/contexts/people/infrastructure/composition";
import { NO_REACH } from "@/contexts/people/domain/reachability";
import { readReachability } from "@/contexts/people/infrastructure/composition";
import { toActor } from "@/app/_lib/api";
import { NotFoundError, type Actor } from "@/shared/errors";
import { AddContactButton } from "../../_components/add-contact-dialog";
import { dealDialogData } from "../../_components/deal-dialog-data";
import { DealsList } from "../../_components/deals-list";
import { EventList } from "@/app/(app)/_components/person/activity";
import { MetaLine, RecordBody, RecordHeader, RecordPage, RecordSection } from "@/app/(app)/_components/record/record-header";
import { moneyTotalsText } from "../../_components/money-text";
import { CompanyActions } from "./company-actions";
import { CompanyCreateDeal } from "./company-create-deal";
import { CompanyDetails } from "./company-form";

export const metadata: Metadata = { title: "Company" };

export default function CompanyPage({ params }: PageProps<"/crm/companies/[id]">) {
  return (
    <Suspense
      fallback={
        <>
          <PageHeader title="Company" titleAs="p" back={{ href: "/crm/companies", label: "Companies" }} />
          <RecordPage>
            <Skeleton className="h-28 w-full" aria-hidden />
            <RecordBody
              asideLabel="Company details"
              main={
                <>
                  <Skeleton className="h-48 w-full" aria-hidden />
                  <Skeleton className="h-40 w-full" aria-hidden />
                </>
              }
              aside={<Skeleton className="h-56 w-full" aria-hidden />}
            />
          </RecordPage>
        </>
      }
    >
      <Company params={params} />
    </Suspense>
  );
}

const safeUrl = (url: string | null) => (url && /^https?:\/\//i.test(url) ? url : null);
const fieldText = (value: unknown) => (value === null || value === undefined ? "" : typeof value === "string" ? value : JSON.stringify(value));

async function Company({ params }: { params: PageProps<"/crm/companies/[id]">["params"] }) {
  await connection();
  const { id } = await params;
  const actor = toActor(await requireOrgContext());

  let detail;
  try {
    detail = await getCompany(dealsDeps(), actor, id);
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    throw error;
  }
  const { company, deals, summary } = detail;
  // The Contacts section and Activity read the contacts in one order, last activity first.
  const contacts = byLastActivity(detail.contacts);
  const [columns, dialog, reach] = await Promise.all([
    listCustomColumns(customColumnStore, actor, { entity: "companies", includeArchived: false }),
    dealDialogData(actor),
    readReachability(actor.organizationId, contacts.map((c) => c.id)),
  ]);
  const now = new Date().toISOString();
  const title = company.name ?? company.domain;
  const linkedin = safeUrl(company.linkedinUrl);
  const known = new Set(columns.map((c) => c.key));
  const editable = columns.filter((c) => !c.isCore).map((c) => ({ key: c.key, name: c.name, value: fieldText(company.custom[c.key]) }));
  const stale = Object.entries(company.custom)
    .filter(([key]) => !known.has(key))
    .map(([key, value]) => ({ key, name: key, value: fieldText(value) }))
    .filter((f) => f.value !== "");
  const contactNames = new Map(contacts.map((c) => [c.id, c.name ?? c.email ?? "Contact"]));
  const { openDeals } = summary;
  const openAmount = moneyTotalsText(summary.openAmounts);
  const addContact = (props: { label?: string; variant?: "default" | "outline" }) => (
    <AddContactButton {...props} members={dialog.members} currentUserId={dialog.currentUserId} stages={dialog.stages} initialDomain={company.domain} />
  );

  return (
    <>
      <PageHeader title={title} titleAs="p" back={{ href: "/crm/companies", label: "Companies" }} />
      <RecordPage>
        <RecordHeader
          testId="company-header"
          name={title}
          subtitle={
            <span className="flex flex-wrap items-center gap-x-4 gap-y-1">
              <a href={`https://${company.domain}`} target="_blank" rel="noreferrer noopener" className="inline-flex min-h-6 items-center gap-1 break-all text-foreground underline-offset-4 hover:underline max-sm:min-h-11" aria-label={`${company.domain} (opens in a new tab)`}>
                {company.domain}
                <ExternalLinkIcon aria-hidden className="size-3.5 text-muted-foreground" />
              </a>
              {linkedin && (
                <a href={linkedin} target="_blank" rel="noreferrer noopener" className="inline-flex min-h-6 items-center gap-1 text-foreground underline-offset-4 hover:underline max-sm:min-h-11" aria-label="LinkedIn page (opens in a new tab)">
                  LinkedIn page
                  <ExternalLinkIcon aria-hidden className="size-3.5 text-muted-foreground" />
                </a>
              )}
            </span>
          }
          status={
            <MetaLine
              label="Company summary"
              testId="company-summary"
              items={[
                <span key="contacts">{`${summary.contacts} ${summary.contacts === 1 ? "contact" : "contacts"}`}</span>,
                <span key="deals">{`${openDeals} open ${openDeals === 1 ? "deal" : "deals"}`}</span>,
                openAmount && (
                  <span key="amount" className="text-foreground tabular-nums">
                    {`${openAmount} open`}
                  </span>
                ),
              ]}
            />
          }
          actions={
            <>
              {/* A deal starts from a contact, so a company without one leads with Add contact. */}
              {contacts.length === 0 && addContact({})}
              <CompanyCreateDeal
                contacts={contacts.map((c) => {
                  const r = reach.get(c.id) ?? NO_REACH;
                  return { id: c.id, name: c.name, email: c.email, companyName: company.name, doNotContact: r.doNotContact !== null, suppressed: r.email.state === "suppressed", openDeals: c.openDeals };
                })}
                stages={dialog.stages}
                members={dialog.members}
                currentUserId={dialog.currentUserId}
              />
              <CompanyActions
                company={{ id: company.id, name: company.name, domain: company.domain, version: company.version, contacts: company.contacts, leads: company.leads }}
                inUseText={companyInUseMessage(company, { contacts: company.contacts, leads: company.leads })}
              />
            </>
          }
        />
        <RecordBody
          asideLabel="Company details"
          main={
            <>
              <RecordSection title="Contacts" count={contacts.length || undefined} testId="company-contacts">
                {contacts.length === 0 ? (
                  <EmptyState
                    className="py-0"
                    title={`No contacts at ${title}`}
                    description={`${title} stays in Companies until you delete it or merge it into another company.`}
                    action={
                      <div className="flex flex-wrap gap-2 max-sm:[&_a]:h-11 max-sm:[&_button]:h-11">
                        {addContact({ variant: "outline" })}
                        <Link href={`/leads?q=${encodeURIComponent(company.domain)}`} className={buttonVariants({ variant: "outline" })}>
                          Find its leads
                        </Link>
                      </div>
                    }
                  />
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Name</TableHead>
                        <TableHead>Title</TableHead>
                        <TableHead className="text-right">Open deals</TableHead>
                        <TableHead>Last activity</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {contacts.map((contact) => (
                        <TableRow key={contact.id} className={rowLinkClasses}>
                          <TableCell className="min-w-36 whitespace-normal">
                            <RowLink href={`/crm/contacts/${contact.id}?from=${encodeURIComponent(`/crm/companies/${company.id}`)}`}>{contact.name ?? "Unnamed contact"}</RowLink>
                          </TableCell>
                          <TableCell className="max-w-56 truncate">{contact.title ?? ""}</TableCell>
                          <TableCell className="text-right">{contact.openDeals}</TableCell>
                          <TableCell>{contact.lastActivityAt ? <Time value={contact.lastActivityAt} relativeTo={now} /> : <span className="text-muted-foreground">None yet</span>}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </RecordSection>

              <RecordSection title="Deals" count={deals.length === 0 ? undefined : `${openDeals} open of ${deals.length}`} testId="company-deals">
                {deals.length === 0 ? (
                  <EmptyState
                    className="py-2"
                    title="No deals yet"
                    description={contacts.length > 0 ? "Use Create deal above and pick one of its contacts." : "A deal starts from a contact, and this company has none yet."}
                  />
                ) : (
                  <DealsList deals={deals} contactNames={contactNames} />
                )}
              </RecordSection>

              {contacts.length > 0 && (
                <Suspense fallback={<Skeleton className="h-40 w-full" />}>
                  <CompanyActivity actor={actor} contacts={contacts.map((c) => ({ id: c.id, name: c.name ?? c.email ?? "Contact" }))} />
                </Suspense>
              )}
            </>
          }
          aside={
            <>
              <CompanyDetails
                // New key after each save, so the panel shows the values the server stored.
                key={`${company.name ?? ""}|${company.linkedinUrl ?? ""}|${JSON.stringify(company.custom)}`}
                id={company.id}
                domain={company.domain}
                otherDomains={company.aliases}
                created={new Date(company.createdAt).toISOString()}
                initial={{ name: company.name ?? "", linkedin: linkedin ?? "" }}
                customFields={editable}
                staleFields={stale}
              />
            </>
          }
        />
      </RecordPage>
    </>
  );
}

const COMPANY_HISTORY_LIMIT = 30;
/** The company page reads at most this many contacts' histories: the first ones of the Contacts section's order. */
const COMPANY_HISTORY_PEOPLE = 25;

/** Last activity first, a contact with none last, then the newest contact first, as `contactsOfCompany` returns them. */
function byLastActivity(contacts: ContactListRow[]): ContactListRow[] {
  const at = (c: ContactListRow) => c.lastActivityAt?.getTime() ?? Number.NEGATIVE_INFINITY;
  return contacts.map((contact, index) => ({ contact, index })).sort((a, b) => at(b.contact) - at(a.contact) || a.index - b.index).map(({ contact }) => contact);
}

/**
 * What happened with the company's contacts, newest first, each line named after its person. It reads the first 25 contacts in
 * the Contacts section's order and keeps the latest 30 lines, and says so when either cap could hide a line.
 */
async function CompanyActivity({ actor, contacts }: { actor: Actor; contacts: Array<{ id: string; name: string }> }) {
  await connection();
  const lists = await Promise.all(
    contacts.slice(0, COMPANY_HISTORY_PEOPLE).map(async (c) => (await personReplyHandling.listPersonEvents(actor.organizationId, c.id, COMPANY_HISTORY_LIMIT)).map((e) => ({ ...e, who: c.name }))),
  );
  const all = lists.flat();
  const events = all.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id)).slice(0, COMPANY_HISTORY_LIMIT);
  const capped = contacts.length > COMPANY_HISTORY_PEOPLE || all.length >= COMPANY_HISTORY_LIMIT;
  return (
    <RecordSection title="Activity" testId="company-activity">
      {capped && (
        <p className="-mt-1.5 text-sm text-muted-foreground" data-testid="company-activity-cap">
          The latest 30 lines from up to 25 contacts.
        </p>
      )}
      <EventList events={events} who limit={COMPANY_HISTORY_LIMIT} />
    </RecordSection>
  );
}
