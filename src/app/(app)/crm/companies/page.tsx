import { ExternalLinkIcon } from "lucide-react";
import type { Metadata } from "next";
import { connection } from "next/server";
import { Suspense } from "react";
import { EmptyState } from "@/components/shell/empty-state";
import { PageHeader } from "@/components/shell/page-header";
import { RowLink, rowLinkClasses } from "@/components/shell/row-link";
import { Time } from "@/components/shell/time";
import { ScrollableTable } from "@/components/ui/scrollable-table";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { CompanySort } from "@/contexts/deals/application/deal-ports";
import { listCompanies } from "@/contexts/deals/application/deals";
import { dealsDeps } from "@/composition/deals";
import { requireOrgContext } from "@/contexts/identity/infrastructure/session";
import { toActor } from "@/app/_lib/api";
import { ListToolbar } from "@/components/shell/list-toolbar";
import { SearchField } from "@/components/shell/search-field";
import { ListPager, pageCountOf, SortHeader } from "@/components/shell/list-pager";
import { AddCompanyButton } from "../_components/add-company-dialog";
import { moneyTotalsText } from "../_components/money-text";

export const metadata: Metadata = { title: "Companies" };

export default function CompaniesPage({ searchParams }: PageProps<"/crm/companies">) {
  return (
    <>
      <PageHeader title="Companies" actions={<AddCompanyButton />} />
      <div className="page stack-group">
        <Suspense
          fallback={
            <div className="stack-group" aria-hidden>
              <Skeleton className="h-9 w-full max-w-md" />
              <Skeleton className="h-80 w-full" />
            </div>
          }
        >
          <Companies searchParams={searchParams} />
        </Suspense>
      </div>
    </>
  );
}

const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);
const SORTS: readonly CompanySort[] = ["name", "contacts", "open_deals"];

function companiesHref(state: { q: string; sort: CompanySort; page?: number }): string {
  const params = new URLSearchParams();
  if (state.q) params.set("q", state.q);
  if (state.sort !== "name") params.set("sort", state.sort);
  if (state.page && state.page > 1) params.set("page", String(state.page));
  const query = params.toString();
  return query ? `/crm/companies?${query}` : "/crm/companies";
}

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The phone line under a company name: "3 contacts · 1 open deal", then the last activity when there is one. */
const phoneLine = (contacts: number, openDeals: number) => `${count(contacts, "contact", "contacts")} · ${count(openDeals, "open deal", "open deals")}`;

/** A LinkedIn company page, shown only for an http(s) URL. */
const safeUrl = (url: string | null) => (url && /^https?:\/\//i.test(url) ? url : null);

async function Companies({ searchParams }: { searchParams: PageProps<"/crm/companies">["searchParams"] }) {
  await connection();
  const actor = toActor(await requireOrgContext());
  const params = await searchParams;
  const q = first(params.q)?.trim().slice(0, 100) ?? "";
  const asked = first(params.sort) as CompanySort | undefined;
  const sort: CompanySort = asked && SORTS.includes(asked) ? asked : "name";
  const page = Math.max(1, Math.trunc(Number(first(params.page))) || 1);
  const { rows, total, pageSize } = await listCompanies(dealsDeps(), actor, { q, sort, page });
  const pageCount = pageCountOf(total, pageSize);
  const now = new Date().toISOString();
  // Name sorts A to Z; the counts sort high to low. A second click on a count returns to the name order.
  const sortTo = (key: CompanySort) => companiesHref({ q, sort: sort === key ? "name" : key });

  return (
    <>
      <form action="/crm/companies" aria-label="Company search">
        {sort !== "name" && <input type="hidden" name="sort" value={sort} />}
        <ListToolbar>
          <SearchField label="Search companies" defaultValue={q} placeholder="Search company name or domain" />
        </ListToolbar>
      </form>

      {total === 0 ? (
        q ? (
          <EmptyState title="No companies match" description="Try another name or domain." action={{ label: "Clear search", href: "/crm/companies" }} />
        ) : (
          <EmptyState
            title="No companies yet"
            description="Add a company, or create a deal from a lead. A deal's contact brings their company here."
            action={<AddCompanyButton variant="outline" />}
          />
        )
      ) : rows.length === 0 ? (
        <EmptyState title="This page is empty" description={`The list has ${pageCount} ${pageCount === 1 ? "page" : "pages"}.`} action={{ label: "First page", href: companiesHref({ q, sort }) }} />
      ) : (
        <ScrollableTable>
          <Table>
            <caption className="sr-only">{sort === "name" ? "Sorted by name" : sort === "contacts" ? "Most contacts first" : "Most open deals first"}</caption>
            <TableHeader>
              <TableRow>
                <TableHead aria-sort={sort === "name" ? "ascending" : undefined}>
                  <SortHeader label="Company" sortKey="name" active={sort === "name"} href={companiesHref({ q, sort: "name" })} />
                </TableHead>
                <TableHead className="max-md:hidden">Domain</TableHead>
                <TableHead className="text-right" aria-sort={sort === "contacts" ? "descending" : undefined}>
                  <SortHeader label="Contacts" sortKey="contacts" active={sort === "contacts"} href={sortTo("contacts")} />
                </TableHead>
                <TableHead className="text-right" aria-sort={sort === "open_deals" ? "descending" : undefined}>
                  <SortHeader label="Open deals" sortKey="open_deals" active={sort === "open_deals"} href={sortTo("open_deals")} />
                </TableHead>
                <TableHead className="text-right max-md:hidden">Open amount</TableHead>
                <TableHead className="max-md:hidden">Last activity</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((company) => {
                const linkedin = safeUrl(company.linkedinUrl);
                const name = company.name ?? company.domain;
                return (
                  <TableRow key={company.id} className={rowLinkClasses}>
                    <TableCell className="max-w-64">
                      <div className="flex min-w-0 items-center gap-1">
                        <RowLink href={`/crm/companies/${company.id}`} className="truncate">
                          {name}
                        </RowLink>
                        {linkedin && (
                          <a
                            href={linkedin}
                            target="_blank"
                            rel="noreferrer noopener"
                            className="relative z-10 -my-1 inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring max-sm:-my-2 max-sm:size-11"
                            aria-label={`LinkedIn page of ${name} (opens in a new tab)`}
                            title="LinkedIn page"
                          >
                            <ExternalLinkIcon aria-hidden className="size-3.5" />
                          </a>
                        )}
                      </div>
                      {/* Below md the Domain, Open amount and Last activity columns hide, so the name cell carries them. */}
                      <div className="grid text-xs text-muted-foreground md:hidden">
                        <span className="truncate">{company.domain}</span>
                        <span>
                          {phoneLine(company.contacts, company.openDeals)}
                          {company.lastActivityAt && (
                            <>
                              {" · "}
                              <Time value={company.lastActivityAt} relativeTo={now} />
                            </>
                          )}
                        </span>
                      </div>
                    </TableCell>
                    <TableCell className="max-w-56 truncate text-muted-foreground max-md:hidden">{company.domain}</TableCell>
                    <TableCell className="text-right tabular-nums">{company.contacts}</TableCell>
                    <TableCell className="text-right tabular-nums">{company.openDeals}</TableCell>
                    <TableCell className="text-right whitespace-nowrap tabular-nums max-md:hidden">{moneyTotalsText(company.openAmounts) ?? ""}</TableCell>
                    <TableCell className="text-muted-foreground max-md:hidden">{company.lastActivityAt ? <Time value={company.lastActivityAt} relativeTo={now} /> : "None yet"}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </ScrollableTable>
      )}

      {total > 0 && <ListPager total={total} page={page} pageCount={pageCount} noun={["company", "companies"]} hrefFor={(p) => companiesHref({ q, sort, page: p })} />}
    </>
  );
}
