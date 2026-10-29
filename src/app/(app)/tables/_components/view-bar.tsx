"use client";

import { AppliedFilters } from "@/components/shell/filter-chip";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
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
  const conjunction = view.filters?.conjunction;
  return (
    <>
      <AppliedFilters
        chips={[
          ...conditions.map((c, i) => ({ key: `condition-${i}`, value: describeCondition(c, nameOf), muted: !isFilterGroup(c) && c.disabled === true, onRemove: () => void saveView(removeFilter(view, i)) })),
          ...(view.sorts ?? []).map((s) => ({ key: `sort-${s.columnKey}`, name: "Sort", value: `${nameOf(s.columnKey)} ${s.direction === "asc" ? "A to Z" : "Z to A"}`, onRemove: () => void saveView(setSort(view, s.columnKey, null)) })),
        ]}
        extra={
          conditions.length > 1 && (
            <Tooltip>
              <TooltipTrigger render={<Button size="xs" variant="ghost" onClick={() => void saveView(setConjunction(view, conjunction === "or" ? "and" : "or"))} />}>
                Match {conjunction === "or" ? "any" : "all"}
              </TooltipTrigger>
              <TooltipContent>Switch to match {conjunction === "or" ? "all" : "any"}</TooltipContent>
            </Tooltip>
          )
        }
        clear={{ onClick: () => void saveView({ ...view, filters: undefined, sorts: [] }) }}
      />

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
