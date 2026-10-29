"use client";

import { ArrowDownIcon, ArrowUpIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { MAX_SORTS, type SortSpec } from "@/contexts/grid/domain/view-query";
import { addSort, canAddSort, moveSort, nextSortColumn, removeSortAt, setSortColumn, setSortDirection } from "../_lib/edit/filter-edit";
import type { GridColumn } from "../_lib/data/types";
import { ItemSelect, PHONE_SELECT } from "./form-bits";

/** The sorts of a view in order, each with its column, direction, move and remove, then Add sort. It edits the draft it is given. */
export function SortList({ columns, sorts, onChange }: { columns: GridColumn[]; sorts: SortSpec[]; onChange: (next: SortSpec[]) => void }) {
  const keys = columns.map((c) => c.key);
  const next = nextSortColumn(sorts, keys);
  return (
    <>
      {sorts.length === 0 && <p className="text-sm text-muted-foreground">No sorts, so rows keep the table order.</p>}
      {sorts.map((s, i) => (
        <div key={i} className="flex flex-wrap items-center gap-1.5" role="group" aria-label={`Sort ${i + 1}`}>
          <span className="w-12 text-xs text-muted-foreground">{i === 0 ? "Sort by" : "then by"}</span>
          <div className="min-w-32 flex-1">
            <ItemSelect label={`Sort ${i + 1} column`} className={PHONE_SELECT} value={s.columnKey} items={columns.map((c) => ({ value: c.key, label: c.name }))} onChange={(key) => onChange(setSortColumn(sorts, i, key))} />
          </div>
          <div className="w-48">
            <ItemSelect
              label={`Sort ${i + 1} direction`}
              className={PHONE_SELECT}
              value={s.direction}
              items={[
                { value: "asc", label: "A to Z, low to high" },
                { value: "desc", label: "Z to A, high to low" },
              ]}
              onChange={(d) => onChange(setSortDirection(sorts, i, d === "desc" ? "desc" : "asc"))}
            />
          </div>
          <Button type="button" size="icon-sm" touch variant="ghost" aria-label={`Move sort ${i + 1} up`} disabled={i === 0} onClick={() => onChange(moveSort(sorts, i, -1))}>
            <ArrowUpIcon />
          </Button>
          <Button type="button" size="icon-sm" touch variant="ghost" aria-label={`Move sort ${i + 1} down`} disabled={i === sorts.length - 1} onClick={() => onChange(moveSort(sorts, i, 1))}>
            <ArrowDownIcon />
          </Button>
          <Button type="button" size="icon-sm" touch variant="ghost" aria-label={`Remove sort ${i + 1}`} onClick={() => onChange(removeSortAt(sorts, i))}>
            <Trash2Icon />
          </Button>
        </div>
      ))}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Button type="button" size="xs" touch variant="outline" disabled={!canAddSort(sorts) || next === null} onClick={() => next && onChange(addSort(sorts, next))}>
          <PlusIcon /> Add sort
        </Button>
        {/* Why Add sort is off, in text: a tooltip never reaches a disabled button on touch or from the keyboard. */}
        {!canAddSort(sorts) ? (
          <span className="text-xs text-muted-foreground">Up to {MAX_SORTS} sorts.</span>
        ) : next === null ? (
          <span className="text-xs text-muted-foreground">Every column is already sorted.</span>
        ) : null}
        {sorts.length > 0 && <span className="text-xs text-muted-foreground">Empty cells go last in both directions.</span>}
      </div>
    </>
  );
}
