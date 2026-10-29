"use client";

import type { ReactNode } from "react";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DatePicker } from "./date-picker";
import { useDraftValue } from "./filter-popover";

const ROW = "grid grid-cols-[8rem_minmax(0,1fr)] items-center gap-3 max-sm:grid-cols-1 max-sm:gap-1.5";
const ROW_LABEL = "text-sm text-muted-foreground";

/** A group of rows under a small title. Sections after the first sit under a hairline. */
export function FilterSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section aria-label={title} className="stack-group not-first:border-t not-first:pt-inset">
      <h3 className="text-xs font-medium text-muted-foreground">{title}</h3>
      {children}
    </section>
  );
}

/**
 * One filter: the label on the left and the control on the right, stacked on a phone. The control also carries the
 * label as its own name, since a wrapping label adds the control's text to the name.
 */
export function FilterRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className={ROW}>
      <span className={ROW_LABEL}>{label}</span>
      {children}
    </label>
  );
}

/** One choice of a `SelectField`. An empty value posts nothing, as Any does. */
export interface FilterOption {
  value: string;
  label: string;
}

/** The Select keeps "" for no choice, so the empty option takes this value inside it and posts "" again. */
const EMPTY = "\u0000empty";

/**
 * The app's Select in a row, posted through a hidden input under `name`, so a GET form sends the same param a native
 * select did. The first option is the one Reset picks; a value the options do not hold falls back to it, as a native
 * select's would.
 */
export function SelectField({ label, name, defaultValue, options }: { label: string; name: string; defaultValue: string; options: FilterOption[] }) {
  const known = (v: string) => (options.some((o) => o.value === v) ? v : (options[0]?.value ?? ""));
  const [value, setValue] = useDraftValue(known(defaultValue), options[0]?.value ?? "");
  const items = options.map((o) => ({ value: o.value === "" ? EMPTY : o.value, label: o.label }));
  return (
    <FilterRow label={label}>
      <Select items={items} value={value === "" ? EMPTY : value} onValueChange={(v) => v !== null && setValue(v === EMPTY ? "" : v)}>
        <SelectTrigger aria-label={label} className="w-full min-w-0 max-sm:data-[size=default]:h-11">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {items.map((item) => (
            <SelectItem key={item.value} value={item.value}>
              {item.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <input type="hidden" name={name} value={value} />
    </FilterRow>
  );
}

/** A text field in a row. */
export function TextField({ label, name, defaultValue, placeholder }: { label: string; name: string; defaultValue: string; placeholder?: string }) {
  return (
    <FilterRow label={label}>
      <Input name={name} defaultValue={defaultValue} placeholder={placeholder} aria-label={label} className="max-sm:h-11" />
    </FilterRow>
  );
}

/** A checkbox row for a yes-only filter, such as Errors only. */
export function CheckField({ label, name, defaultChecked }: { label: string; name: string; defaultChecked: boolean }) {
  return (
    <label className="flex min-h-8 items-center gap-2 text-sm max-sm:min-h-11">
      <input type="checkbox" name={name} value="1" defaultChecked={defaultChecked} className="size-4 accent-primary" />
      {label}
    </label>
  );
}

const TRISTATE = [
  { value: "", label: "Any" },
  { value: "yes", label: "Yes" },
  { value: "no", label: "No" },
] as const;

/** Any, Yes or No as one segmented control of native radios. Any posts nothing. */
export function TristateField({ label, name, value }: { label: string; name: string; value: boolean | undefined }) {
  const current = value === undefined ? "" : value ? "yes" : "no";
  return (
    <div role="radiogroup" aria-label={label} className={ROW}>
      <span aria-hidden className={ROW_LABEL}>
        {label}
      </span>
      <div className="grid h-8 grid-cols-3 rounded-lg border border-input p-0.5 max-sm:h-11 dark:bg-input/30">
        {TRISTATE.map((o) => (
          <label
            key={o.value}
            className="grid cursor-pointer place-items-center rounded-md text-sm text-muted-foreground hover:text-foreground has-checked:bg-muted has-checked:font-medium has-checked:text-foreground has-focus-visible:ring-3 has-focus-visible:ring-ring/50"
          >
            <input type="radio" name={name} value={o.value} defaultChecked={current === o.value} className="sr-only" />
            {o.label}
          </label>
        ))}
      </div>
    </div>
  );
}

/**
 * A from and to date pair on one row, two `DatePicker`s named `from.name` and `to.name`. Each is named "{label} from" and
 * "{label} to", and Clear empties one end.
 */
export function DateRangeField({ label, from, to }: { label: string; from: { name: string; value: string }; to: { name: string; value: string } }) {
  const [start, setStart] = useDraftValue(from.value, "");
  const [end, setEnd] = useDraftValue(to.value, "");
  return (
    <div role="group" aria-label={label} className={ROW}>
      <span aria-hidden className={ROW_LABEL}>
        {label}
      </span>
      <div className="grid grid-cols-2 gap-2">
        <DatePicker name={from.name} value={start} onChange={setStart} aria-label={`${label} from`} placeholder="From" clearable className="w-full min-w-0" />
        <DatePicker name={to.name} value={end} onChange={setEnd} aria-label={`${label} to`} placeholder="To" clearable className="w-full min-w-0" />
      </div>
    </div>
  );
}
