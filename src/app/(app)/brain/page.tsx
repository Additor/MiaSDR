import type { Metadata } from "next";
import { connection } from "next/server";
import { cache, Suspense } from "react";
import { EmptyState } from "@/components/shell/empty-state";
import { FilterChips } from "@/components/shell/filter-chips";
import { ListPager, pageCountOf } from "@/components/shell/list-pager";
import { ListToolbar } from "@/components/shell/list-toolbar";
import { PageHeader } from "@/components/shell/page-header";
import { PageSkeleton } from "@/components/shell/page-skeleton";
import { RowLink, rowLinkClasses } from "@/components/shell/row-link";
import { SearchField } from "@/components/shell/search-field";
import { Time } from "@/components/shell/time";
import { ViewSwitch } from "@/components/shell/view-switch";
import { Badge } from "@/components/ui/badge";
import { ScrollableTable } from "@/components/ui/scrollable-table";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { toActor } from "@/app/_lib/api";
import { brainHasActiveCompanyProfile, listBrainItems, type BrainView } from "@/contexts/brain/application/brain-items";
import { BRAIN_GROUP_LABELS, BRAIN_KIND_LABELS, type BrainGroup } from "@/contexts/brain/domain/brain-kinds";
import { brainStore } from "@/contexts/brain/infrastructure/composition";
import { requireOrgContext } from "@/contexts/identity/infrastructure/session";
import { miaUnavailable, openSuggestionCount, openSuggestions, recentRuns } from "@/contexts/mia/application/mia-use-cases";
import { miaDeps } from "@/contexts/mia/infrastructure/composition";
import { parsePageParam } from "@/shared/page-param";
import { AddBrainItemButton } from "./_components/brain-buttons";
import { FillWithMiaButton, MiaRunLines } from "./_components/mia-controls";
import { MiaSuggestions } from "./_components/mia-suggestions";

export const metadata: Metadata = { title: "Brain" };

export default function BrainPage({ searchParams }: PageProps<"/brain">) {
  return (
    <>
      <PageHeader
        title="Brain"
        actions={
          <Suspense fallback={null}>
            <HeaderAdd />
          </Suspense>
        }
      />
      <div className="page stack-group">
        <Suspense fallback={<PageSkeleton shape="list" />}>
          <BrainList searchParams={searchParams} />
        </Suspense>
      </div>
    </>
  );
}

/** The header and the list's empty state both ask, so one request reads it once. */
const hasCompanyProfileNow = cache(async () => brainHasActiveCompanyProfile(brainStore, toActor(await requireOrgContext())));

/** Why Mia cannot start a job here now, or null. */
const miaUnavailableNow = cache(async () => miaUnavailable(miaDeps(), toActor(await requireOrgContext())));

async function HeaderAdd() {
  await connection();
  const [hasCompanyProfile, unavailable] = await Promise.all([hasCompanyProfileNow(), miaUnavailableNow()]);
  return (
    <>
      <FillWithMiaButton unavailable={unavailable} />
      <AddBrainItemButton hasCompanyProfile={hasCompanyProfile} />
    </>
  );
}

const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);
const GROUPS = Object.keys(BRAIN_GROUP_LABELS) as BrainGroup[];
type PageView = BrainView | "suggestions";
const VIEWS: readonly PageView[] = ["all", ...GROUPS, "needs_sorting", "suggestions"];

const EMPTY_DESCRIPTIONS: Record<BrainView, string> = {
  all: "Add your company, products and pricing. Reply drafts draw on them.",
  company: "Add your company, products and pricing. Reply drafts draw on them.",
  market: "Add your ICPs, competitors, case studies and testimonials. Reply drafts draw on case studies so far.",
  skills: "Add the objections you hear and who you qualify. Reply drafts draw on objections so far.",
  needs_sorting: "Documents from before Brain had kinds wait here. There are none left.",
};

function brainHref(state: { view: PageView; archived: boolean; q: string; page?: number }): string {
  const params = new URLSearchParams();
  if (state.view !== "all") params.set("view", state.view);
  if (state.archived) params.set("status", "archived");
  if (state.q) params.set("q", state.q);
  if (state.page && state.page > 1) params.set("page", String(state.page));
  const query = params.toString();
  return query ? `/brain?${query}` : "/brain";
}

async function BrainList({ searchParams }: { searchParams: PageProps<"/brain">["searchParams"] }) {
  await connection();
  const actor = toActor(await requireOrgContext());
  const params = await searchParams;
  const asked = first(params.view) as PageView | undefined;
  const picked: PageView = asked && VIEWS.includes(asked) ? asked : "all";
  const view: BrainView = picked === "suggestions" ? "all" : picked;
  const archived = first(params.status) === "archived";
  const q = first(params.q)?.trim().slice(0, 100) ?? "";
  const deps = miaDeps();
  const [{ rows, total, page, pageSize, needsSorting }, hasCompanyProfile, suggestions, runs, unavailable] = await Promise.all([
    listBrainItems(brainStore, actor, { view, q, archived, page: parsePageParam(first(params.page)) }),
    hasCompanyProfileNow(),
    // Building the list reads each item a suggestion changes, and the page refreshes while a job runs. The other views show only the number.
    picked === "suggestions" ? openSuggestions(deps, actor) : openSuggestionCount(deps, actor).then((total) => ({ rows: [], total })),
    recentRuns(deps, actor),
    miaUnavailableNow(),
  ]);
  const pageCount = pageCountOf(total, pageSize);
  const now = new Date().toISOString();

  const viewItems = [
    { href: brainHref({ view: "all", archived, q }), label: "All", active: picked === "all" },
    ...GROUPS.map((group) => ({ href: brainHref({ view: group, archived, q }), label: BRAIN_GROUP_LABELS[group], active: picked === group })),
    ...(needsSorting > 0 || view === "needs_sorting" ? [{ href: brainHref({ view: "needs_sorting", archived, q }), label: `Needs sorting (${needsSorting})`, active: picked === "needs_sorting", testId: "brain-needs-sorting" }] : []),
    { href: brainHref({ view: "suggestions", archived: false, q: "" }), label: suggestions.total > 0 ? `Suggestions (${suggestions.total})` : "Suggestions", active: picked === "suggestions", testId: "brain-suggestions" },
  ];

  if (picked === "suggestions") {
    return (
      <>
        <ViewSwitch label="Brain views" items={viewItems} />
        <MiaRunLines runs={runs} />
        <MiaSuggestions rows={suggestions.rows} total={suggestions.total} />
      </>
    );
  }

  return (
    <>
      <ViewSwitch label="Brain views" items={viewItems} />
      <MiaRunLines runs={runs} />
      <form action="/brain" aria-label="Brain search">
        {view !== "all" && <input type="hidden" name="view" value={view} />}
        {archived && <input type="hidden" name="status" value="archived" />}
        <ListToolbar
          filters={
            <FilterChips
              label="Status"
              items={[
                { href: brainHref({ view, archived: false, q }), label: "Active", active: !archived },
                { href: brainHref({ view, archived: true, q }), label: "Archived", active: archived, testId: "brain-archived" },
              ]}
            />
          }
        >
          <SearchField label="Search Brain" defaultValue={q} placeholder="Search titles" maxLength={100} />
        </ListToolbar>
      </form>

      {total === 0 ? (
        q ? (
          <EmptyState title="Nothing matches" description="Try another title." action={{ label: "Clear search", href: brainHref({ view, archived, q: "" }) }} />
        ) : archived ? (
          <EmptyState title="Nothing archived" />
        ) : (
          <EmptyState
            title={view === "all" ? "Brain is empty" : "Nothing here yet"}
            description={EMPTY_DESCRIPTIONS[view]}
            action={
              view === "all" ? (
                <div className="flex flex-wrap justify-center gap-2">
                  <FillWithMiaButton unavailable={unavailable} variant="default" />
                  <AddBrainItemButton hasCompanyProfile={hasCompanyProfile} variant="outline" />
                </div>
              ) : (
                <AddBrainItemButton hasCompanyProfile={hasCompanyProfile} variant="outline" />
              )
            }
          />
        )
      ) : rows.length === 0 ? (
        <EmptyState title="This page is empty" action={{ label: "First page", href: brainHref({ view, archived, q }) }} />
      ) : (
        <ScrollableTable>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Title</TableHead>
                <TableHead>Kind</TableHead>
                <TableHead className="max-md:hidden">Tags</TableHead>
                <TableHead className="text-right max-md:hidden">Version</TableHead>
                <TableHead className="max-md:hidden">Updated</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((item) => (
                <TableRow key={item.id} data-testid="brain-item" className={rowLinkClasses}>
                  <TableCell className="max-w-96">
                    <div className="flex min-w-0 items-center gap-2">
                      <RowLink href={`/brain/${item.id}`} className="truncate">
                        {item.title}
                      </RowLink>
                      {item.legacy && <Badge variant="secondary">Needs sorting</Badge>}
                      {!item.active && <Badge variant="secondary">Archived</Badge>}
                    </div>
                    {item.description && <p className="truncate text-xs text-muted-foreground">{item.description}</p>}
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-muted-foreground">{BRAIN_KIND_LABELS[item.kind]}</TableCell>
                  <TableCell className="max-w-48 truncate text-muted-foreground max-md:hidden">{item.tags.join(", ")}</TableCell>
                  <TableCell className="text-right text-muted-foreground tabular-nums max-md:hidden">{item.version}</TableCell>
                  <TableCell className="whitespace-nowrap text-muted-foreground max-md:hidden">
                    <Time value={item.updatedAt} relativeTo={now} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </ScrollableTable>
      )}
      {total > 0 && <ListPager total={total} page={page} pageCount={pageCount} noun={["item", "items"]} hrefFor={(target) => brainHref({ view, archived, q, page: target })} />}
    </>
  );
}
