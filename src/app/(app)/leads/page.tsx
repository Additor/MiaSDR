import type { Metadata } from "next";
import Link from "next/link";
import { cookies } from "next/headers";
import { connection } from "next/server";
import { Suspense } from "react";
import { EmptyState } from "@/components/shell/empty-state";
import { ActiveFilterChips } from "@/components/shell/filter-panel";
import { PageHeader } from "@/components/shell/page-header";
import { SelectionProvider } from "@/components/shell/selection";
import { buttonVariants } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { requireOrgContext } from "@/contexts/identity/infrastructure/session";
import { isFilterActive, leadFilterParams, parseLeadFilter, parseLeadSort } from "@/contexts/leads/domain/lead-filter";
import { leadFilterOptions, listLeads } from "@/contexts/leads/infrastructure/composition";
import { readLeadActivity } from "@/contexts/outreach/application/read-lead-activity";
import { leadActivityDeps } from "@/contexts/outreach/infrastructure/composition";
import { cn } from "@/lib/utils";
import { toActor } from "@/app/_lib/api";
import type { Actor } from "@/shared/errors";
import { dealDialogData } from "../crm/_components/deal-dialog-data";
import { StateTip } from "../crm/_components/person/state-tip";
import { AddToCampaign } from "./add-to-campaign";
import { ColumnsMenu, LeadColumnsProvider } from "./columns-menu";
import { leadsHref } from "./list-url";
import { activeFilterChips, panelFilterCount } from "./active-filters";
import { columnsCookieName, parseColumns } from "./list-columns";
import { LeadsFilterBar } from "./leads-filter-bar";
import { LeadsTableView } from "./leads-table";

export const metadata: Metadata = { title: "Leads" };

export default function LeadsPage({ searchParams }: PageProps<"/leads">) {
  return (
    <>
      <PageHeader
        title="Leads"
        actions={
          <>
            <Link href="/leads/searches" className={cn(buttonVariants({ variant: "outline" }))}>
              LinkedIn searches
            </Link>
            <Link href="/leads/import" className={cn(buttonVariants())}>
              Import
            </Link>
          </>
        }
      />
      {/* The selection bar sticks to the bottom edge, so the page ends at the bar with no padding below it. */}
      <div className="page stack-group pb-0">
        <Suspense fallback={<Skeleton className="h-96 w-full" />}>
          <LeadsContent searchParams={searchParams} />
        </Suspense>
      </div>
    </>
  );
}

const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);

async function LeadsContent({ searchParams }: { searchParams: PageProps<"/leads">["searchParams"] }) {
  await connection();
  const context = await requireOrgContext();
  const params = await searchParams;
  return <People actor={toActor(context)} params={params} />;
}

type Params = Awaited<PageProps<"/leads">["searchParams"]>;

async function People({ actor, params }: { actor: Actor; params: Params }) {
  const { organizationId, userId } = actor;
  const filter = parseLeadFilter((key) => first(params[key]));
  // The list never takes an explicit id selection from the URL; that is for the export link.
  filter.ids = undefined;
  const sort = parseLeadSort(first(params.sort), first(params.dir));
  const [{ rows, total, page, pageCount, pageSize }, options, deals] = await Promise.all([
    listLeads(organizationId, { filter, sort, page: Number(first(params.page)) || 1, pageSize: Number(first(params.size)) || undefined }),
    leadFilterOptions(organizationId),
    dealDialogData(actor),
  ]);
  // The lead page reads the same function for its one id, so a row and its page show one state.
  const activity = await readLeadActivity(leadActivityDeps(), organizationId, rows);
  const columns = parseColumns((await cookies()).get(columnsCookieName(userId))?.value);
  const now = new Date().toISOString();
  const active = isFilterActive(filter);
  const chips = activeFilterChips(filter, options);
  const exportParams = leadFilterParams(filter).toString();

  return (
    <LeadColumnsProvider initial={columns} userId={userId}>
      <LeadsFilterBar
        filter={filter}
        sort={sort}
        size={pageSize}
        options={options}
        panelCount={panelFilterCount(chips)}
        end={
          <>
            {total > 0 && <ColumnsMenu />}
            {total === 0 ? (
              <StateTip
                trigger={<button type="button" aria-disabled="true" className={cn(buttonVariants({ variant: "outline", size: "sm" }), "cursor-not-allowed opacity-50 max-sm:h-11")} />}
                tip={active ? "No leads match, so there is nothing to export." : "Import leads to export them."}
              >
                {active ? "Export filtered CSV" : "Export CSV"}
              </StateTip>
            ) : (
              <a href={`/api/leads/export${exportParams ? `?${exportParams}` : ""}`} download className={cn(buttonVariants({ variant: "outline", size: "sm" }), "max-sm:h-11")}>
                {active ? "Export filtered CSV" : "Export CSV"}
              </a>
            )}
          </>
        }
      />
      <ActiveFilterChips chips={chips.map((chip) => ({ key: chip.key, name: chip.name, value: chip.value, href: leadsHref({ filter: chip.without, sort, size: pageSize }) }))} clearHref={leadsHref({ filter: {}, sort, size: pageSize })} />

      {total === 0 ? (
        <EmptyState
          title={active ? "No leads match" : "No leads yet"}
          description={active ? "Remove a filter above, or change the search." : "Import a CSV or Excel file with at least an email or LinkedIn profile column."}
          action={active ? undefined : { label: "Import leads", href: "/leads/import" }}
        />
      ) : (
        // The key resets the selection when the filter changes. Sort, page and size keep it, so a person can tick rows across pages.
        <SelectionProvider key={leadFilterParams(filter).toString()}>
          <LeadsTableView
            rows={rows.map((r) => ({
              id: r.id,
              fullName: r.fullName,
              email: r.email,
              title: r.title,
              companyName: r.companyName,
              companyDomain: r.companyDomain,
              lifecycle: r.lifecycle === "contact" ? "contact" : "lead",
              createdAt: r.createdAt.toISOString(),
              updatedAt: r.updatedAt.toISOString(),
              // `readLeadActivity` returns an entry for each row it was given.
              activity: activity.get(r.id)!,
            }))}
            userId={userId}
            now={now}
            total={total}
            page={page}
            pageCount={pageCount}
            pageSize={pageSize}
            filter={filter}
            sort={sort}
            bulkActions={<AddToCampaign />}
            deals={{ stages: deals.stages, members: deals.members }}
          />
        </SelectionProvider>
      )}
    </LeadColumnsProvider>
  );
}
