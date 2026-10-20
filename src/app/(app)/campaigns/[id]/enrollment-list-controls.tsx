import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";
import { ENROLLMENT_PAGE_SIZES, ENROLLMENT_TAB_LABELS, campaignLeadTabs, type EnrollmentListQuery, type TabCounts } from "@/contexts/outreach/domain/enrollment-list";
import { leadsListHref } from "@/contexts/outreach/domain/campaign-view";
import { cn } from "@/lib/utils";
import { SearchField } from "@/components/shell/search-field";
import { ListPager, pageCountOf } from "@/components/shell/list-pager";
import { FilterChips } from "@/components/shell/filter-chips";

/**
 * Status filters (lead status words scoped to the campaign; counts cover the whole campaign), search box and page size
 * of a campaign lead table. The filters narrow the list, so they are chips; the campaign tabs above stay a view switch.
 */
export function EnrollmentListFilters({ base, query, counts, campaignStatus }: { base: string; query: EnrollmentListQuery; counts: TabCounts; campaignStatus: string }) {
  return (
    <div className="stack-group">
      <FilterChips
        label="Lead status"
        items={campaignLeadTabs(campaignStatus, counts, query.tab).map((tab) => ({
          href: leadsListHref(base, { ...query, tab, page: 1 }),
          active: query.tab === tab,
          testId: `tab-${tab}`,
          label: (
            <>
              {ENROLLMENT_TAB_LABELS[tab]} <span className="ml-1.5 tabular-nums opacity-70">{counts[tab].toLocaleString("en-US")}</span>
            </>
          ),
        }))}
      />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <form action={base} method="get" role="search" className="flex min-w-0 max-w-full items-center gap-2">
          {query.tab !== "all" && <input type="hidden" name="status" value={query.tab} />}
          {query.pageSize !== 50 && <input type="hidden" name="size" value={query.pageSize} />}
          <SearchField label="Search leads" defaultValue={query.search} placeholder="Search name, email, title, company" maxLength={100} className="w-72 max-w-full flex-none" />
          {query.search && (
            <Link href={leadsListHref(base, { ...query, search: "", page: 1 })} className={cn(buttonVariants({ variant: "ghost", size: "sm" }))}>
              Clear
            </Link>
          )}
        </form>
        <div className="flex items-center gap-1 text-sm text-muted-foreground">
          <span>Rows</span>
          {ENROLLMENT_PAGE_SIZES.map((size) => (
            <Link
              key={size}
              href={leadsListHref(base, { ...query, pageSize: size, page: 1 })}
              aria-current={query.pageSize === size ? "true" : undefined}
              className={cn(buttonVariants({ variant: query.pageSize === size ? "secondary" : "ghost", size: "sm" }))}
            >
              {size}
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}

/** The count of the current filter and, with more than one page, Previous and Next. */
export function EnrollmentPager({ base, query, total }: { base: string; query: EnrollmentListQuery; total: number }) {
  return <ListPager total={total} page={query.page} pageCount={pageCountOf(total, query.pageSize)} noun={["lead", "leads"]} hrefFor={(page) => leadsListHref(base, { ...query, page })} />;
}
