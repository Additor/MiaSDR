"use client";

import { ArrowDownIcon, ArrowUpIcon, EyeOffIcon, EyeIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { effectiveColumnType } from "@/contexts/grid/domain/column-types";
import { isFilterGroup, MAX_SORTS, MAX_VIEW_CONDITIONS, MAX_VIEW_DEPTH, validateView, type FilterCondition, type FilterGroup, type SortSpec, type TableView } from "@/contexts/grid/domain/view-query";
import {
  addCondition,
  addGroup,
  addSort,
  canAddGroup,
  canAddCondition,
  canAddSort,
  defaultOperatorFor,
  emptyGroup,
  moveSort,
  nextSortColumn,
  normalizeFilters,
  operatorAfterColumnChange,
  operatorsFor,
  RUN_FILLED_TYPES,
  removeNode,
  removeSortAt,
  setGroupConjunction,
  setSortColumn,
  setSortDirection,
  toggleMuted,
  updateCondition,
  type NodePath,
} from "../_lib/edit/filter-edit";
import { typeLabel } from "../_lib/view/format";
import type { GridColumn } from "../_lib/data/types";
import { OPERATOR_LABELS, operatorNeedsValue } from "../_lib/view/view";
import { Choice, ErrorText } from "./form-bits";

interface Props {
  columns: GridColumn[];
  view: TableView;
  /** Saves the whole view and resolves true when it was stored. */
  saveView: (view: TableView) => Promise<boolean>;
  onClose: () => void;
}

/**
 * The filter and sort panel. It edits a draft and saves once with Apply, so a half-typed value never reaches
 * the server and one Apply is one view write. A muted condition stays in the view and filters nothing.
 */
export function FilterPanel({ columns, view, saveView, onClose }: Props) {
  const [filters, setFilters] = useState<FilterGroup>(() => view.filters ?? emptyGroup());
  const [sorts, setSorts] = useState<SortSpec[]>(() => [...(view.sorts ?? [])]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const types = useMemo(() => new Map(columns.map((c) => [c.key, effectiveColumnType(c)] as const)), [columns]);
  const known = useMemo(() => new Set(columns.map((c) => c.key)), [columns]);
  const firstColumn = columns[0];

  const newCondition = (): FilterCondition => ({ columnKey: firstColumn.key, operator: defaultOperatorFor(types.get(firstColumn.key) ?? "text"), value: "" });
  const mutedCount = countMuted(filters);

  async function apply() {
    const next: TableView = { ...view, filters: normalizeFilters(filters), sorts };
    const problem = validateView({ filters: next.filters, sorts }, known, types);
    if (problem) return setError(problem);
    setBusy(true);
    setError(null);
    const saved = await saveView(next);
    setBusy(false);
    if (saved) onClose();
    else setError("Could not save the view. Try again.");
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Filter and sort</DialogTitle>
          <DialogDescription>Rows must match the conditions below. Mute a condition to keep it without applying it. Changes take effect when you press Apply.</DialogDescription>
        </DialogHeader>

        <section aria-label="Filters" className="grid gap-2">
          <h3 className="text-sm font-medium">Filters{mutedCount > 0 ? ` (${mutedCount} muted)` : ""}</h3>
          {firstColumn ? (
            <>
              <GroupEditor group={filters} path={[]} columns={columns} types={types} root={filters} onChange={setFilters} newCondition={newCondition} />
              {filters.conditions.length === 0 && <p className="text-xs text-muted-foreground">No conditions, so every row shows.</p>}
            </>
          ) : (
            <p className="text-xs text-muted-foreground">This table has no columns yet.</p>
          )}
        </section>

        <section aria-label="Sorts" className="grid gap-2">
          <h3 className="text-sm font-medium">Sorts</h3>
          <p className="text-xs text-muted-foreground">The first sort comes first. Rows with an empty cell go last in both directions. Up to {MAX_SORTS} sorts.</p>
          {sorts.map((s, i) => (
            <div key={i} className="flex flex-wrap items-center gap-1.5" role="group" aria-label={`Sort ${i + 1}`}>
              <span className="w-12 text-xs text-muted-foreground">{i === 0 ? "Sort by" : "then by"}</span>
              <div className="min-w-36 flex-1">
                <Choice label={`Sort ${i + 1} column`} value={s.columnKey} items={columns.map((c) => ({ value: c.key, label: c.name }))} onChange={(key) => setSorts(setSortColumn(sorts, i, key))} />
              </div>
              <div className="w-36">
                <Choice
                  label={`Sort ${i + 1} direction`}
                  value={s.direction}
                  items={[
                    { value: "asc", label: "A to Z, low to high" },
                    { value: "desc", label: "Z to A, high to low" },
                  ]}
                  onChange={(d) => setSorts(setSortDirection(sorts, i, d === "desc" ? "desc" : "asc"))}
                />
              </div>
              <Button type="button" size="icon-sm" variant="ghost" aria-label={`Move sort ${i + 1} up`} disabled={i === 0} onClick={() => setSorts(moveSort(sorts, i, -1))}>
                <ArrowUpIcon />
              </Button>
              <Button type="button" size="icon-sm" variant="ghost" aria-label={`Move sort ${i + 1} down`} disabled={i === sorts.length - 1} onClick={() => setSorts(moveSort(sorts, i, 1))}>
                <ArrowDownIcon />
              </Button>
              <Button type="button" size="icon-sm" variant="ghost" aria-label={`Remove sort ${i + 1}`} onClick={() => setSorts(removeSortAt(sorts, i))}>
                <Trash2Icon />
              </Button>
            </div>
          ))}
          <div>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={!canAddSort(sorts) || nextSortColumn(sorts, columns.map((c) => c.key)) === null}
              title={!canAddSort(sorts) ? `Up to ${MAX_SORTS} sorts` : nextSortColumn(sorts, columns.map((c) => c.key)) === null ? "Every column is already sorted" : undefined}
              onClick={() => {
                const key = nextSortColumn(sorts, columns.map((c) => c.key));
                if (key) setSorts(addSort(sorts, key));
              }}
            >
              <PlusIcon /> Add sort
            </Button>
          </div>
        </section>

        <ErrorText>{error}</ErrorText>
        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              setFilters(emptyGroup());
              setSorts([]);
              setError(null);
            }}
          >
            Clear all
          </Button>
          <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="button" onClick={() => void apply()} disabled={busy}>
            {busy ? "Applying..." : "Apply"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function countMuted(group: FilterGroup): number {
  return group.conditions.reduce((n, c) => n + (isFilterGroup(c) ? countMuted(c) : c.disabled ? 1 : 0), 0);
}

interface GroupProps {
  group: FilterGroup;
  path: NodePath;
  root: FilterGroup;
  columns: GridColumn[];
  types: ReadonlyMap<string, string>;
  onChange: (root: FilterGroup) => void;
  newCondition: () => FilterCondition;
}

function GroupEditor({ group, path, root, columns, types, onChange, newCondition }: GroupProps) {
  const nested = path.length > 0;
  const label = nested ? `Group ${path.map((p) => p + 1).join(".")}` : "Conditions";
  return (
    <div className={nested ? "grid gap-2 rounded-lg border bg-muted/30 p-2" : "grid gap-2"} role="group" aria-label={label}>
      {group.conditions.length > 1 && (
        <div className="flex items-center gap-1.5 text-xs">
          <span className="text-muted-foreground">Match</span>
          <Button type="button" size="xs" variant={group.conjunction === "and" ? "default" : "outline"} aria-pressed={group.conjunction === "and"} onClick={() => onChange(setGroupConjunction(root, path, "and"))}>
            all
          </Button>
          <Button type="button" size="xs" variant={group.conjunction === "or" ? "default" : "outline"} aria-pressed={group.conjunction === "or"} onClick={() => onChange(setGroupConjunction(root, path, "or"))}>
            any
          </Button>
          <span className="text-muted-foreground">of these</span>
        </div>
      )}
      {group.conditions.map((c, i) => {
        const childPath = [...path, i];
        if (isFilterGroup(c)) return <GroupEditor key={i} group={c} path={childPath} root={root} columns={columns} types={types} onChange={onChange} newCondition={newCondition} />;
        return <ConditionRow key={i} condition={c} path={childPath} root={root} columns={columns} types={types} onChange={onChange} />;
      })}
      <div className="flex flex-wrap gap-1.5">
        <Button type="button" size="xs" variant="outline" disabled={!canAddCondition(root)} title={canAddCondition(root) ? undefined : `A view holds up to ${MAX_VIEW_CONDITIONS} conditions`} onClick={() => onChange(addCondition(root, path, newCondition()))}>
          <PlusIcon /> {nested ? "Add condition to group" : "Add condition"}
        </Button>
        <Button type="button" size="xs" variant="outline" disabled={!canAddGroup(root, path)} title={canAddGroup(root, path) ? undefined : `Groups nest up to ${MAX_VIEW_DEPTH} levels, and a view holds up to ${MAX_VIEW_CONDITIONS} conditions`} onClick={() => onChange(addGroup(root, path, newCondition()))}>
          <PlusIcon /> Add group
        </Button>
      </div>
    </div>
  );
}

interface RowProps {
  condition: FilterCondition;
  path: NodePath;
  root: FilterGroup;
  columns: GridColumn[];
  types: ReadonlyMap<string, string>;
  onChange: (root: FilterGroup) => void;
}

function ConditionRow({ condition, path, root, columns, types, onChange }: RowProps) {
  const name = path.map((p) => p + 1).join(".");
  const type = types.get(condition.columnKey) ?? "text";
  const runs = RUN_FILLED_TYPES.has(columns.find((c) => c.key === condition.columnKey)?.type ?? "");
  // A view saved when output columns offered "run failed" keeps showing it, so the person sees it and can change it.
  const operators = operatorsFor(type, { runs: runs || condition.operator === "runFailed" });
  const muted = condition.disabled === true;
  return (
    <div className={`flex flex-wrap items-center gap-1.5 ${muted ? "opacity-60" : ""}`} role="group" aria-label={`Condition ${name}${muted ? " (muted)" : ""}`}>
      <div className="min-w-32 flex-1">
        <Choice
          label={`Condition ${name} column`}
          value={condition.columnKey}
          items={columns.map((c) => ({ value: c.key, label: `${c.name} (${typeLabel(c.type)})` }))}
          onChange={(key) => onChange(updateCondition(root, path, { columnKey: key, operator: operatorAfterColumnChange(condition.operator, types.get(key) ?? "text") }))}
        />
      </div>
      <div className="w-40">
        <Choice
          label={`Condition ${name} operator`}
          value={condition.operator}
          items={operators.map((op) => ({ value: op, label: OPERATOR_LABELS[op] }))}
          onChange={(op) => onChange(updateCondition(root, path, { operator: operators.find((o) => o === op) ?? condition.operator }))}
        />
      </div>
      {operatorNeedsValue(condition.operator) && (
        <Input aria-label={`Condition ${name} value`} className="min-w-28 flex-1" value={condition.value ?? ""} onChange={(e) => onChange(updateCondition(root, path, { value: e.target.value }))} />
      )}
      <Button type="button" size="icon-sm" variant={muted ? "secondary" : "ghost"} aria-pressed={muted} aria-label={muted ? `Unmute condition ${name}` : `Mute condition ${name}`} onClick={() => onChange(toggleMuted(root, path))}>
        {muted ? <EyeOffIcon /> : <EyeIcon />}
      </Button>
      <Button type="button" size="icon-sm" variant="ghost" aria-label={`Remove condition ${name}`} onClick={() => onChange(removeNode(root, path))}>
        <Trash2Icon />
      </Button>
    </div>
  );
}
