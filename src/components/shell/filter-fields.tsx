import type { ReactNode } from "react";
import { Input } from "@/components/ui/input";

/** A native select sized like an Input. */
const SELECT =
  "h-8 w-full min-w-0 rounded-lg border border-input bg-transparent px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 max-sm:h-11 dark:bg-input/30 dark:[color-scheme:dark]";

const ROW = "grid grid-cols-[8rem_minmax(0,1fr)] items-center gap-3 max-sm:grid-cols-1 max-sm:gap-1.5";
const ROW_LABEL = "text-sm text-muted-foreground";

/** A group of rows under a small title. Sections after the first sit under a hairline. */
export function FilterSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section aria-label={title} className="grid gap-2.5 not-first:border-t not-first:pt-4">
      <h3 className="text-xs font-medium text-muted-foreground">{title}</h3>
      {children}
    </section>
  );
}

/**
 * One filter: the label on the left and the control on the right, stacked on a phone. The control also carries the
 * label as its own name, since a wrapping label adds a select's value to the name.
 */
export function FilterRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className={ROW}>
      <span className={ROW_LABEL}>{label}</span>
      {children}
    </label>
  );
}

/**
 * A native select in a row. Pass the options as children; the first is the one Reset picks. A link to another URL keeps
 * the page mounted, and React does not move an uncontrolled select to a new default, so the key renders it again.
 */
export function SelectField({ label, name, defaultValue, children }: { label: string; name: string; defaultValue: string; children: ReactNode }) {
  return (
    <FilterRow label={label}>
      <select key={defaultValue} name={name} defaultValue={defaultValue} aria-label={label} className={SELECT}>
        {children}
      </select>
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

/** A from and to date pair on one row. Each field is named "{label} from" and "{label} to". */
export function DateRangeField({ label, from, to }: { label: string; from: { name: string; value: string }; to: { name: string; value: string } }) {
  return (
    <div role="group" aria-label={label} className={ROW}>
      <span aria-hidden className={ROW_LABEL}>
        {label}
      </span>
      <div className="grid grid-cols-2 gap-2">
        <Input type="date" name={from.name} defaultValue={from.value} aria-label={`${label} from`} className="max-sm:h-11" />
        <Input type="date" name={to.name} defaultValue={to.value} aria-label={`${label} to`} className="max-sm:h-11" />
      </div>
    </div>
  );
}
