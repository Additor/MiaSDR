"use client";

import { EyeOffIcon, EyeIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { useMemo } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { effectiveColumnType } from "@/contexts/grid/domain/column-types";
import { isFilterGroup, MAX_VIEW_CONDITIONS, MAX_VIEW_DEPTH, type FilterCondition, type FilterGroup } from "@/contexts/grid/domain/view-query";
import {
  addCondition,
  addGroup,
  canAddGroup,
  canAddCondition,
  defaultOperatorFor,
  operatorAfterColumnChange,
  operatorsFor,
  RUN_FILLED_TYPES,
  removeNode,
  setGroupConjunction,
  toggleMuted,
  updateCondition,
  type NodePath,
} from "../_lib/edit/filter-edit";
import { typeLabel } from "../_lib/view/format";
import type { GridColumn } from "../_lib/data/types";
import { OPERATOR_LABELS, operatorNeedsValue } from "../_lib/view/view";
import { Choice } from "./form-bits";

/**
 * The conditions of a view as an editable tree: column, operator, value, mute and remove per condition, groups nested up
 * to the view's depth, and Match all or any where a group holds more than one. It edits the draft it is given.
 */
export function ConditionBuilder({ columns, filters, onChange }: { columns: GridColumn[]; filters: FilterGroup; onChange: (next: FilterGroup) => void }) {
  const types = useMemo(() => new Map(columns.map((c) => [c.key, effectiveColumnType(c)] as const)), [columns]);
  const firstColumn = columns[0];
  if (!firstColumn) return <p className="text-sm text-muted-foreground">This table has no columns yet.</p>;
  const newCondition = (): FilterCondition => ({ columnKey: firstColumn.key, operator: defaultOperatorFor(types.get(firstColumn.key) ?? "text"), value: "" });
  return (
    <>
      <GroupEditor group={filters} path={[]} columns={columns} types={types} root={filters} onChange={onChange} newCondition={newCondition} />
      {filters.conditions.length === 0 && <p className="text-sm text-muted-foreground">No conditions, so every row shows.</p>}
    </>
  );
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
