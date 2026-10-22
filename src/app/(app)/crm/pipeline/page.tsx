import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import { SearchField } from "@/components/shell/search-field";
import { EmptyState } from "@/components/shell/empty-state";
import { FilterChips } from "@/components/shell/filter-chips";
import { PageHeader } from "@/components/shell/page-header";
import { ScrollCue } from "@/components/shell/scroll-cue";
import { buttonVariants } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { taskDeps } from "@/contexts/conversations/actions/infrastructure/task-composition";
import { board, isUuid } from "@/contexts/deals/application/deals";
import { dealsDeps } from "@/composition/deals";
import { requireOrgContext } from "@/contexts/identity/infrastructure/session";
import { toActor } from "@/app/_lib/api";
import type { DealStageList } from "../_components/deal-form";
import { toJson } from "../_components/serialize";
import { BoardColumn } from "./board-column";
import { BoardMovesProvider } from "./board-moves";
import { boardHref, parseBoardUrl, type BoardUrlState } from "./board-url";
import { OwnerFilter } from "./owner-filter";

export const metadata: Metadata = { title: "Pipeline" };

export default function PipelinePage({ searchParams }: PageProps<"/crm/pipeline">) {
  return (
    <>
      <PageHeader title="Pipeline" />
      <div className="page stack-group">
        <Suspense fallback={<BoardSkeleton />}>
          <Board searchParams={searchParams} />
        </Suspense>
      </div>
    </>
  );
}

function BoardSkeleton() {
  return (
    <div className="stack-group" data-testid="board-loading" aria-busy="true" aria-label="Loading the pipeline">
      <div className="flex flex-wrap gap-2">
        <Skeleton className="h-8 w-full max-w-sm" />
        <Skeleton className="h-8 w-40" />
      </div>
      <div className="flex gap-3 overflow-hidden">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="grid w-72 shrink-0 content-start gap-2">
            <Skeleton className="h-5 w-24" />
            <Skeleton className="h-28 w-full" />
            <Skeleton className="h-28 w-full" />
          </div>
        ))}
      </div>
    </div>
  );
}

/** An owner the use case accepts: me, none or a user id. Anything else is dropped rather than failing the page. */
function ownerParam(owner: string | undefined): string | undefined {
  return owner === "me" || owner === "none" || isUuid(owner) ? owner : undefined;
}

async function Board({ searchParams }: { searchParams: PageProps<"/crm/pipeline">["searchParams"] }) {
  await connection();
  const actor = toActor(await requireOrgContext());
  const parsed = parseBoardUrl(await searchParams);
  const state: BoardUrlState = { ...parsed, owner: ownerParam(parsed.owner) };
  const deps = dealsDeps();
  const [view, members] = await Promise.all([board(deps, actor, { owner: state.owner, q: state.q, showAll: state.showAll }), taskDeps().store.members(actor.organizationId)]);
  const nowMs = deps.now().getTime();
  const filtered = Boolean(state.owner || state.q);
  const shown = view.columns.reduce((sum, c) => sum + c.total, 0);
  // Won and Lost hide deals closed more than 30 days ago, so an empty window can still hide history: then show the columns.
  const hasOlder = shown === 0 && !view.virtual && !state.showAll && (await board(deps, actor, { owner: state.owner, q: state.q, showAll: true, limit: 1 })).columns.some((c) => c.total > 0);
  const total = hasOlder ? 1 : shown;
  const stages: DealStageList = { virtual: view.virtual, stages: view.columns.map(({ id, name, kind, position }) => ({ id, name, kind, position })) };
  const columns = toJson(view.columns);

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <form className="flex min-w-0 flex-1 basis-56 items-center" action="/crm/pipeline">
          {state.owner && <input type="hidden" name="owner" value={state.owner} />}
          {state.showAll && <input type="hidden" name="showAll" value="1" />}
          <SearchField label="Search deals" defaultValue={state.q} placeholder="Search deal, contact or company" className="max-w-sm" />
        </form>
        <OwnerFilter state={state} members={members} currentUserId={actor.userId} />
        <FilterChips label="Closed deals" items={[{ href: boardHref({ ...state, showAll: !state.showAll }), label: "Show all", active: Boolean(state.showAll) }]} />
      </div>

      {total === 0 ? (
        filtered ? (
          <EmptyState title="No deals match these filters." description="Try another owner or search." action={{ label: "Clear filters", href: boardHref({ showAll: state.showAll }) }} />
        ) : (
          <EmptyState
            title="No deals yet."
            description="Create a deal from a lead that replied."
            action={
              <Link href="/leads?hasConversation=yes" className={buttonVariants({ variant: "outline" })}>
                Show leads that replied
              </Link>
            }
          />
        )
      ) : (
        <BoardMovesProvider stages={stages}>
          <ScrollCue hint="Scroll sideways for more stages" className="gap-3 p-1 pb-2" data-testid="board">
          {columns.map((column) => (
            <BoardColumn
              key={`${column.id}:${column.total}:${column.cards.map((c) => `${c.id}.${c.version}`).join(",")}`}
              column={column}
              stages={stages}
              nowMs={nowMs}
              query={{ owner: state.owner, q: state.q, showAll: Boolean(state.showAll) }}
              closedWindow={!state.showAll}
            />
          ))}
          </ScrollCue>
        </BoardMovesProvider>
      )}
    </>
  );
}
