"use client";

import { cloneElement, isValidElement } from "react";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { typeLabel } from "../_lib/view/format";
import type { GridColumn } from "../_lib/data/types";

/** A labelled control with an optional hint. The hint is tied to a single control child with aria-describedby, so a screen reader reads it with the field. */
export function Field({ label, htmlFor, hint, children, className }: { label: string; htmlFor?: string; hint?: string; children: React.ReactNode; className?: string }) {
  const hintId = hint && htmlFor ? `${htmlFor}-hint` : undefined;
  const control = hintId && isValidElement<{ "aria-describedby"?: string }>(children) ? cloneElement(children, { "aria-describedby": hintId }) : children;
  return (
    <div className={cn("stack-field", className)}>
      <Label htmlFor={htmlFor}>{label}</Label>
      {control}
      {hint && (
        <p id={hintId} className="text-xs text-muted-foreground">
          {hint}
        </p>
      )}
    </div>
  );
}

export function ErrorText({ children }: { children: React.ReactNode }) {
  if (!children) return null;
  return (
    <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/10 px-2.5 py-1.5 text-sm text-destructive">
      {children}
    </p>
  );
}

const NONE = "__none__";

export interface Item {
  value: string;
  label: string;
}

/** A single choice from a fixed list. The Select needs its items up front to show the label of the current value. */
export function Choice({ id, value, onChange, items, className, placeholder, label }: { id?: string; value: string; onChange: (value: string) => void; items: Item[]; className?: string; placeholder?: string; label?: string }) {
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
export function ColumnChoice({
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
  return <Choice id={id} label={label} className={className} items={items} value={value ?? (none ? NONE : "")} onChange={(v) => onChange(v === NONE ? null : v)} placeholder="Choose a column" />;
}
