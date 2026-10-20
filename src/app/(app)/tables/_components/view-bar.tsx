"use client";

import { FilterXIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { isFilterGroup, type TableView } from "@/contexts/grid/domain/view-query";
import { describeCondition, removeFilter, setConjunction, setSort } from "../_lib/view/view";

interface Props {
  view: TableView;
  nameOf: (columnKey: string) => string;
  saveView: (view: TableView) => Promise<boolean>;
  /** True when this member has stored a view of their own. */
  personalView: boolean;
  canEditDefault: boolean;
  onResetView: () => Promise<boolean>;
  onSaveDefaultView: () => Promise<boolean>;
}

/** The chips for active filters and sorts, and the notice that shows when the member looks at their own view. */
export function ViewBar({ view, nameOf, saveView, personalView, canEditDefault, onResetView, onSaveDefaultView }: Props) {
  const conditions = view.filters?.conditions ?? [];
  return (
    <>
      {(conditions.length > 0 || (view.sorts?.length ?? 0) > 0) && (
        <div className="flex flex-wrap items-center gap-1.5 text-xs" aria-label="Active filters and sorts">
          {conditions.map((c, i) => (
            <span key={i} className={`flex items-center gap-1 rounded-full border bg-muted/50 py-0.5 pr-1 pl-2.5 ${!isFilterGroup(c) && c.disabled ? "text-muted-foreground line-through" : ""}`}>
              {i > 0 && <span className="text-muted-foreground">{view.filters?.conjunction}</span>}
              {describeCondition(c, nameOf)}
              <button type="button" aria-label={`Remove filter ${describeCondition(c, nameOf)}`} className="rounded-full p-0.5 hover:bg-muted" onClick={() => void saveView(removeFilter(view, i))}>
                <XIcon className="size-3" />
              </button>
            </span>
          ))}
          {conditions.length > 1 && (
            <Button size="xs" variant="ghost" title={`Switch to match ${view.filters?.conjunction === "or" ? "all" : "any"}`} onClick={() => void saveView(setConjunction(view, view.filters?.conjunction === "or" ? "and" : "or"))}>
              Match {view.filters?.conjunction === "or" ? "any" : "all"}
            </Button>
          )}
          {(view.sorts ?? []).map((s) => (
            <span key={s.columnKey} className="flex items-center gap-1 rounded-full border bg-muted/50 py-0.5 pr-1 pl-2.5">
              Sort {nameOf(s.columnKey)} {s.direction === "asc" ? "A to Z" : "Z to A"}
              <button type="button" aria-label={`Remove sort on ${nameOf(s.columnKey)}`} className="rounded-full p-0.5 hover:bg-muted" onClick={() => void saveView(setSort(view, s.columnKey, null))}>
                <XIcon className="size-3" />
              </button>
            </span>
          ))}
          <Button size="xs" variant="ghost" onClick={() => void saveView({ ...view, filters: undefined, sorts: [] })}>
            <FilterXIcon /> Clear all
          </Button>
        </div>
      )}

      {personalView && (
        <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground" role="region" aria-label="Your view">
          <span>You are looking at your own view. Everyone else sees the default view.</span>
          <Button size="xs" variant="ghost" onClick={() => void onResetView()}>
            Reset to default view
          </Button>
          {canEditDefault && (
            <Button size="xs" variant="outline" onClick={() => void onSaveDefaultView()}>
              Save as default for everyone
            </Button>
          )}
        </div>
      )}
    </>
  );
}
