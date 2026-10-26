import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import { EmptyState } from "@/components/shell/empty-state";
import { PageHeader } from "@/components/shell/page-header";
import { RowLink, rowLinkClasses } from "@/components/shell/row-link";
import { Time } from "@/components/shell/time";
import { SelectionProvider } from "@/components/shell/selection";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { ScrollableTable } from "@/components/ui/scrollable-table";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { ContactSort } from "@/contexts/deals/application/deal-ports";
import { isUuid, listContacts } from "@/contexts/deals/application/deals";
import { dealsDeps } from "@/composition/deals";
import { requireOrgContext } from "@/contexts/identity/infrastructure/session";
import { leadContactPoints } from "@/contexts/people/domain/lead-activity";
import { NO_REACH } from "@/contexts/outreach/domain/reachability";
import { readReachability } from "@/contexts/outreach/infrastructure/composition";
import { cn } from "@/components/ui/utils";
import { toActor } from "@/app/_lib/api";
import { AddContactButton } from "../_components/add-contact-dialog";
import { dealDialogData } from "../_components/deal-dialog-data";
import { DealFilterFields, dealFilterChips } from "../_components/deal-filter-fields";
import { AppliedFilters, type AppliedFilter } from "@/components/shell/filter-chip";
import { FilterPopover } from "@/components/shell/filter-popover";
import { ListToolbar } from "@/components/shell/list-toolbar";
import { SearchField } from "@/components/shell/search-field";
import { ListPager, pageCountOf, SortHeader } from "@/components/shell/list-pager";
import { contactLabel } from "../_components/labels";
import { ReachIcons } from "@/app/(app)/_components/person/reach-icons";
import { StateTip } from "@/app/(app)/_components/person/state-tip";
import { ownerText } from "../pipeline/deal-format";
import { ContactsBulkBar } from "./_components/contacts-bulk-bar";
import { phoneLineParts } from "./_components/contacts-bulk";
import { PageCheckbox, RowCheckbox, SelectableRow, SelectionKeys } from "./_components/contacts-selection";

export const metadata: Metadata = { title: "Contacts" };

export default function ContactsPage({ searchParams }: PageProps<"/crm/contacts">) {
  return (
    <>
      <PageHeader
        title="Contacts"
        actions={
          <Suspense fallback={null}>
            <AddContactAction />
          </Suspense>
        }
      />
      {/* The selection bar sticks to the bottom edge, so the page ends at the bar with no padding below it. */}
      <div className="page stack-group pb-0">
        <Suspense fallback={<ContactsSkeleton />}>
          <Contacts searchParams={searchParams} />
        </Suspense>
      </div>
    </>
  );
}

/** Add contact in the header. It needs the stages and members for "Also create a deal". */
async function AddContactAction() {
  await connection();
  const { stages, members, currentUserId } = await dealDialogData(toActor(await requireOrgContext()));
  return <AddContactButton stages={stages} members={members} currentUserId={currentUserId} />;
}

function ContactsSkeleton() {
  return (
    <div className="stack-group" aria-hidden>
      <Skeleton className="h-9 w-full max-w-md" />
      <Skeleton className="h-80 w-full" />
    </div>
  );
}

const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);
const SORTS: readonly ContactSort[] = ["converted", "name", "activity"];

interface ContactsUrl {
  q: string;
  sort: ContactSort;
  /** The latest deal's owner: a user id, "me" or "none". */
  owner?: string;
  /** The latest deal's stage id. */
  stage?: string;
  page?: number;
}

function contactsHref(state: ContactsUrl): string {
  const entries = {
    q: state.q,
    sort: state.sort === "converted" ? undefined : state.sort,
    owner: state.owner,
    stage: state.stage,
    page: state.page && state.page > 1 ? String(state.page) : undefined,
  };
  const query = new URLSearchParams(Object.entries(entries).filter((entry): entry is [string, string] => Boolean(entry[1]))).toString();
  return query ? `/crm/contacts?${query}` : "/crm/contacts";
}

/** The filter alone (`q`, `owner`, `stage`), as the ids and export routes read it. It also keys the selection. */
function filterQuery(state: ContactsUrl): string {
  const entries = { q: state.q, owner: state.owner, stage: state.stage };
  return new URLSearchParams(Object.entries(entries).filter((entry): entry is [string, string] => Boolean(entry[1]))).toString();
}

/** An owner the use case accepts: me, none or a user id. Anything else drops off rather than failing the page. */
const ownerParam = (owner: string | undefined) => (owner === "me" || owner === "none" || isUuid(owner) ? owner : undefined);

async function Contacts({ searchParams }: { searchParams: PageProps<"/crm/contacts">["searchParams"] }) {
  await connection();
  const actor = toActor(await requireOrgContext());
  const params = await searchParams;
  const q = first(params.q)?.trim().slice(0, 100) ?? "";
  const asked = first(params.sort) as ContactSort | undefined;
  const sort: ContactSort = asked && SORTS.includes(asked) ? asked : "converted";
  const page = Math.max(1, Math.trunc(Number(first(params.page))) || 1);
  const askedOwner = ownerParam(first(params.owner)?.trim());
  const owner = askedOwner === actor.userId ? "me" : askedOwner;
  const askedStage = first(params.stage)?.trim();
  const stage = isUuid(askedStage) ? askedStage : undefined;
  const state: ContactsUrl = { q, sort, owner, stage };
  const [{ rows, total, pageSize }, choices] = await Promise.all([listContacts(dealsDeps(), actor, { q, sort, page, owner, stage }), dealDialogData(actor)]);
  // The same reach read as the lead list and the contact page.
  const reach = await readReachability(actor.organizationId, rows.map((r) => r.id));
  const pageCount = pageCountOf(total, pageSize);
  const now = new Date().toISOString();
  const filtered = Boolean(q || owner || stage);
  const sortTo = (key: ContactSort) => contactsHref({ ...state, sort: sort === key ? "converted" : key });
  const ownerOptions = [
    { value: "me", label: "Me" },
    ...choices.members.filter((m) => m.userId !== actor.userId).map((m) => ({ value: m.userId, label: m.name })),
    { value: "none", label: "No owner" },
  ];
  const stageOptions = choices.stages.stages.flatMap((s) => (s.id ? [{ value: s.id, label: s.name }] : []));
  const dealFilters = { owner, stage, owners: ownerOptions, stages: stageOptions };
  const chips: AppliedFilter[] = [
    ...(q ? [{ key: "q", name: "Search", value: q, href: contactsHref({ ...state, q: "" }) }] : []),
    ...dealFilterChips({ ...dealFilters, without: (key) => contactsHref({ ...state, [key]: undefined }) }),
  ];

  const query = filterQuery(state);
  // Rows link with the list they came from, so the contact page lands back here after a delete.
  const listPath = contactsHref({ ...state, page });
  const exportLabel = filtered ? "Export filtered CSV" : "Export CSV";

  return (
    <>
      <form action="/crm/contacts" aria-label="Filter contacts">
        {sort !== "converted" && <input type="hidden" name="sort" value={sort} />}
        <ListToolbar
          filters={
            <FilterPopover count={(owner ? 1 : 0) + (stage ? 1 : 0)}>
              <DealFilterFields {...dealFilters} />
            </FilterPopover>
          }
          end={
            total === 0 ? (
              <div className="flex items-center gap-2">
                <button type="button" aria-disabled="true" aria-describedby="export-reason" className={cn(buttonVariants({ variant: "outline", size: "sm" }), "cursor-not-allowed opacity-50 max-sm:h-11")}>
                  {exportLabel}
                </button>
                <span id="export-reason" className="text-xs text-muted-foreground">
                  {filtered ? "No contacts match, so there is nothing to export." : "Add contacts to export them."}
                </span>
              </div>
            ) : (
              <a href={`/api/contacts/export${query ? `?${query}` : ""}`} download className={cn(buttonVariants({ variant: "outline", size: "sm" }), "max-sm:h-11")}>
                {exportLabel}
              </a>
            )
          }
        >
          <SearchField label="Search contacts" defaultValue={q} placeholder="Search name, email or company" />
        </ListToolbar>
      </form>
      <AppliedFilters chips={chips} clear={{ href: contactsHref({ q: "", sort }) }} />

      {total === 0 ? (
        filtered ? (
          <EmptyState
            title="No contacts match"
            description={owner || stage ? "Try other filters or another search." : "Try another name, email or company."}
            action={{ label: owner || stage ? "Clear filters" : "Clear search", href: "/crm/contacts" }}
          />
        ) : (
          <EmptyState
            title="No contacts yet"
            description="Add a contact, or create a deal from a lead that replied."
            action={
              <div className="flex flex-wrap gap-2">
                <AddContactButton variant="outline" stages={choices.stages} members={choices.members} currentUserId={choices.currentUserId} />
                <Link href="/leads?hasConversation=yes" className={buttonVariants({ variant: "outline" })}>
                  Leads with a conversation
                </Link>
              </div>
            }
          />
        )
      ) : rows.length === 0 ? (
        <EmptyState title="This page is empty" description={`The list has ${pageCount} ${pageCount === 1 ? "page" : "pages"}.`} action={{ label: "First page", href: contactsHref(state) }} />
      ) : (
        // The key resets the selection when the filter changes. Sort and page keep it, so you can tick rows across pages.
        <SelectionProvider key={query}>
          <SelectionKeys>
            <ScrollableTable>
              <Table>
                <caption className="sr-only">{sort === "converted" ? "Newest contacts first" : sort === "name" ? "Sorted by name" : "Most recent activity first"}</caption>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-8">
                      <PageCheckbox ids={rows.map((r) => r.id)} />
                    </TableHead>
                    <TableHead aria-sort={sort === "name" ? "ascending" : undefined}>
                      <SortHeader label="Name" sortKey="name" active={sort === "name"} href={sortTo("name")} />
                    </TableHead>
                    <TableHead>Reach</TableHead>
                    <TableHead className="max-md:hidden">Email</TableHead>
                    <TableHead className="max-md:hidden">Company</TableHead>
                    <TableHead className="max-md:hidden">Latest deal</TableHead>
                    <TableHead className="max-md:hidden">
                      <StateTip trigger={<span tabIndex={0} className="cursor-default" />} tip="Owner of the latest deal">
                        Deal owner
                      </StateTip>
                    </TableHead>
                    <TableHead className="text-right">Open deals</TableHead>
                    <TableHead className="max-md:hidden" aria-sort={sort === "activity" ? "descending" : undefined}>
                      <SortHeader label="Last activity" sortKey="activity" active={sort === "activity"} href={sortTo("activity")} />
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((contact) => {
                    const label = contactLabel({ fullName: contact.name, email: contact.email });
                    const phoneLine = phoneLineParts({ companyName: contact.companyName, stageName: contact.latestDeal?.stageName ?? null });
                    return (
                      <SelectableRow key={contact.id} id={contact.id} className={rowLinkClasses}>
                        <TableCell className="relative z-10">
                          <RowCheckbox id={contact.id} label={label} />
                        </TableCell>
                        <TableCell className="max-w-72">
                          <RowLink href={`/crm/contacts/${contact.id}?from=${encodeURIComponent(listPath)}`} className="block truncate">
                            {contact.name ?? "Unnamed contact"}
                          </RowLink>
                          {contact.title && <span className="block truncate text-xs text-muted-foreground">{contact.title}</span>}
                          {/* The phone stand-in for the Company, Latest deal and Last activity columns. */}
                          <span className="block truncate text-xs text-muted-foreground md:hidden" data-testid="contact-phone-line">
                            {phoneLine.join(" · ")}
                            {contact.lastActivityAt && (
                              <>
                                {phoneLine.length > 0 && " · "}
                                <Time value={contact.lastActivityAt} relativeTo={now} />
                              </>
                            )}
                          </span>
                        </TableCell>
                        <TableCell>
                          <ReachIcons reach={reach.get(contact.id) ?? NO_REACH} contact={leadContactPoints(contact)} person={contact.name ?? "this contact"} />
                        </TableCell>
                        <TableCell className="max-w-56 truncate text-muted-foreground max-md:hidden">{contact.email ?? ""}</TableCell>
                        <TableCell className="max-w-56 truncate max-md:hidden">{contact.companyName ?? ""}</TableCell>
                        <TableCell className="max-md:hidden">{contact.latestDeal && <Badge variant="outline">{contact.latestDeal.stageName}</Badge>}</TableCell>
                        <TableCell className="max-w-40 truncate text-muted-foreground max-md:hidden">{contact.latestDeal ? ownerText(contact.latestDeal.owner) : ""}</TableCell>
                        <TableCell className="text-right tabular-nums">{contact.openDeals}</TableCell>
                        <TableCell className="text-muted-foreground max-md:hidden">{contact.lastActivityAt ? <Time value={contact.lastActivityAt} relativeTo={now} /> : "None yet"}</TableCell>
                      </SelectableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </ScrollableTable>
          </SelectionKeys>
          <ListPager total={total} page={page} pageCount={pageCount} noun={["contact", "contacts"]} hrefFor={(p) => contactsHref({ ...state, page: p })} />
          <ContactsBulkBar total={total} pageIds={rows.map((r) => r.id)} query={query} />
        </SelectionProvider>
      )}

      {total > 0 && rows.length === 0 && <ListPager total={total} page={page} pageCount={pageCount} noun={["contact", "contacts"]} hrefFor={(p) => contactsHref({ ...state, page: p })} />}
    </>
  );
}
