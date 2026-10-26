"use client";

import { ArrowUpDownIcon, ListFilterIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { ToolbarPopover, ToolbarPopoverBody, ToolbarPopoverFooter, useCloseToolbarPopover } from "@/components/shell/toolbar-popover";
import { effectiveColumnType } from "@/contexts/grid/domain/column-types";
import { activeConditionCount, validateView, type FilterGroup, type SortSpec, type TableView } from "@/contexts/grid/domain/view-query";
import { emptyGroup, normalizeFilters } from "../_lib/edit/filter-edit";
import type { GridColumn } from "../_lib/data/types";
import { ConditionBuilder } from "./condition-builder";
import { SortList } from "./sort-list";

interface Props {
  columns: GridColumn[];
  view: TableView;
  /** Saves the whole view and resolves true when it was stored. */
  saveView: (view: TableView) => Promise<boolean>;
}

/**
 * Validates the next view and saves it once. A refused or failed save keeps the popover open with the reason; a stored
 * one closes it.
 */
function useApply(columns: GridColumn[], saveView: Props["saveView"]) {
  const close = useCloseToolbarPopover();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const types = useMemo(() => new Map(columns.map((c) => [c.key, effectiveColumnType(c)] as const)), [columns]);
  const known = useMemo(() => new Set(columns.map((c) => c.key)), [columns]);
  async function apply(next: TableView) {
    const problem = validateView({ filters: next.filters, sorts: next.sorts }, known, types);
    if (problem) return setError(problem);
    setBusy(true);
    setError(null);
    const saved = await saveView(next);
    setBusy(false);
    if (saved) close();
    else setError("Could not save the view. Try again.");
  }
  return { apply, error, busy };
}

/** The table's Filter: the condition builder over a draft of the view's filters. Muted conditions stay out of the count. */
export function TableFilterPopover({ columns, view, saveView }: Props) {
  const types = useMemo(() => new Map(columns.map((c) => [c.key, effectiveColumnType(c)] as const)), [columns]);
  return (
    <ToolbarPopover icon={ListFilterIcon} label="Filter" count={activeConditionCount(view.filters, types)} size="builder" compact testId="table-filter">
      <FilterDraft columns={columns} view={view} saveView={saveView} />
    </ToolbarPopover>
  );
}

/** Mounts with the popup, so each opening starts from the saved view. */
function FilterDraft({ columns, view, saveView }: Props) {
  const [filters, setFilters] = useState<FilterGroup>(() => view.filters ?? emptyGroup());
  const { apply, error, busy } = useApply(columns, saveView);
  return (
    <>
      <ToolbarPopoverBody>
        <ConditionBuilder columns={columns} filters={filters} onChange={setFilters} />
      </ToolbarPopoverBody>
      <ToolbarPopoverFooter busy={busy} error={error} onReset={() => setFilters(emptyGroup())} onApply={() => void apply({ ...view, filters: normalizeFilters(filters) })} />
    </>
  );
}

/** The table's Sort: the sorts in order over a draft of the view's sorts. */
export function TableSortPopover({ columns, view, saveView }: Props) {
  return (
    <ToolbarPopover icon={ArrowUpDownIcon} label="Sort" count={view.sorts?.length ?? 0} size="builder" compact testId="table-sort">
      <SortDraft columns={columns} view={view} saveView={saveView} />
    </ToolbarPopover>
  );
}

function SortDraft({ columns, view, saveView }: Props) {
  const [sorts, setSorts] = useState<SortSpec[]>(() => [...(view.sorts ?? [])]);
  const { apply, error, busy } = useApply(columns, saveView);
  return (
    <>
      <ToolbarPopoverBody>
        <SortList columns={columns} sorts={sorts} onChange={setSorts} />
      </ToolbarPopoverBody>
      <ToolbarPopoverFooter busy={busy} error={error} onReset={() => setSorts([])} onApply={() => void apply({ ...view, sorts })} />
    </>
  );
}
