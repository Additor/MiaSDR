"use client";

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/components/ui/utils";
import { typeLabel } from "../_lib/view/format";
import type { GridColumn } from "../_lib/data/types";

// Labels, hints and errors come from the Field family in `@/components/ui/field`. This file keeps only the Select
// shorthands the tables dialogs and the Filter and Sort popovers share.

const NONE = "__none__";

/** The Select trigger sets its height on `data-size`, so the phone height needs the same attribute to win. */
export const PHONE_SELECT = "max-sm:data-[size=default]:h-11";

export interface Item {
  value: string;
  label: string;
}

/**
 * The app's `Select` fed from a list of items, full width. The Select needs its items up front to show the label of the
 * current value. It adds no style of its own.
 */
export function ItemSelect({ id, value, onChange, items, className, placeholder, label }: { id?: string; value: string; onChange: (value: string) => void; items: Item[]; className?: string; placeholder?: string; label?: string }) {
  return (
    <Select items={items} value={value} onValueChange={(v) => v !== null && onChange(v)}>
      <SelectTrigger id={id} aria-label={label} className={cn("w-full", className)}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {items.map((item) => (
          <SelectItem key={item.value} value={item.value}>
            {item.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** Picks one column of the table, or nothing when `none` is set. */
export function ColumnSelect({
  id,
  value,
  onChange,
  columns,
  none,
  className,
  label,
}: {
  id?: string;
  value: string | null;
  onChange: (key: string | null) => void;
  columns: readonly GridColumn[];
  /** Label of the empty option. Omit to require a column. */
  none?: string;
  className?: string;
  label?: string;
}) {
  const items: Item[] = [...(none ? [{ value: NONE, label: none }] : []), ...columns.map((c) => ({ value: c.key, label: `${c.name} (${typeLabel(c.type)})` }))];
  return <ItemSelect id={id} label={label} className={className} items={items} value={value ?? (none ? NONE : "")} onChange={(v) => onChange(v === NONE ? null : v)} placeholder="Choose a column" />;
}
