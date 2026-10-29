import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";
import { ENROLLMENT_PAGE_SIZES, ENROLLMENT_TAB_LABELS, campaignLeadTabs, type EnrollmentListQuery, type TabCounts } from "@/contexts/outreach/domain/enrollment-list";
import { leadsListHref } from "@/contexts/outreach/domain/campaign-view";
import { SearchField } from "@/components/shell/search-field";
import { ListPager, pageCountOf } from "@/components/shell/list-pager";
import { FilterChips } from "@/components/shell/filter-chips";
import { ListToolbar } from "@/components/shell/list-toolbar";

/**
 * Status chips (lead status words scoped to the campaign; counts cover the whole campaign) and the search box of a
 * campaign lead table, on the toolbar every list shares. The chips narrow the list; the campaign tabs above stay a view
 * switch. The page size sits with the pager at the foot of the table.
 */
export function EnrollmentListFilters({ base, query, counts, campaignStatus }: { base: string; query: EnrollmentListQuery; counts: TabCounts; campaignStatus: string }) {
  return (
    <ListToolbar>
      <FilterChips
        label="Lead status"
        items={campaignLeadTabs(campaignStatus, counts, query.tab).map((tab) => ({
          href: leadsListHref(base, { ...query, tab, page: 1 }),
          active: query.tab === tab,
          testId: `tab-${tab}`,
          label: ENROLLMENT_TAB_LABELS[tab],
          count: counts[tab],
        }))}
      />
      <form action={base} method="get" role="search" className="flex min-w-48 flex-1 items-center">
        {query.tab !== "all" && <input type="hidden" name="status" value={query.tab} />}
        {query.pageSize !== 50 && <input type="hidden" name="size" value={query.pageSize} />}
        <SearchField label="Search leads" defaultValue={query.search} placeholder="Search name, email, title, company" maxLength={100} className="max-w-sm" />
      </form>
    </ListToolbar>
  );
}

/** The count of the current filter, the page size and, with more than one page, Previous and Next. */
export function EnrollmentPager({ base, query, total }: { base: string; query: EnrollmentListQuery; total: number }) {
  const size = (
    <div className="flex items-center gap-1" role="group" aria-label="Rows per page">
      <span>Rows</span>
      {ENROLLMENT_PAGE_SIZES.map((n) => (
        <Link
          key={n}
          href={leadsListHref(base, { ...query, pageSize: n, page: 1 })}
          aria-current={query.pageSize === n ? "true" : undefined}
          className={buttonVariants({ variant: query.pageSize === n ? "secondary" : "ghost", size: "sm", touch: true })}
        >
          {n}
        </Link>
      ))}
    </div>
  );
  // A list that fits one page at the smallest size has nothing to resize.
  const sized = total > ENROLLMENT_PAGE_SIZES[0] ? size : undefined;
  return <ListPager total={total} page={query.page} pageCount={pageCountOf(total, query.pageSize)} noun={["lead", "leads"]} hrefFor={(page) => leadsListHref(base, { ...query, page })} size={sized} />;
}
