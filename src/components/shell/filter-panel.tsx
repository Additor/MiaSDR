import { XIcon } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { Button, buttonVariants } from "@/components/ui/button";
import { cn } from "@/components/ui/utils";

/** The select of a filter field, sized like an Input. */
export const FILTER_SELECT =
  "h-8 w-full min-w-0 rounded-lg border border-input bg-transparent px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 max-sm:h-11 dark:bg-input/30 dark:[color-scheme:dark]";

export function FilterField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="grid content-start gap-1 text-xs text-muted-foreground">
      {label}
      {children}
    </label>
  );
}

/**
 * The fields behind a list's Filters button, inside the page's GET form: a grid of `FilterField`s with Apply filters at
 * the end, in the same place on every list. Clear filters lives once, with the chips of the filters in force.
 */
export function FilterPanel({ children }: { children: ReactNode }) {
  return (
    <div className="grid gap-3 rounded-lg border p-3">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">{children}</div>
      <div>
        <Button type="submit" size="sm" className="max-sm:h-11 max-sm:px-4">
          Apply filters
        </Button>
      </div>
    </div>
  );
}

export interface ActiveFilterChip {
  key: string;
  name: string;
  value: string;
  /** The same list without this filter. */
  href: string;
}

/**
 * The filters in force as removable chips under the toolbar, with one Clear filters link. Each chip is a link to the
 * same list without that filter, so removing one needs no script.
 */
export function ActiveFilterChips({ chips, clearHref }: { chips: ActiveFilterChip[]; clearHref: string }) {
  if (chips.length === 0) return null;
  return (
    <div role="group" aria-label="Applied filters" className="flex flex-wrap items-center gap-1.5">
      {chips.map((chip) => (
        <Link
          key={chip.key}
          href={chip.href}
          aria-label={`Remove filter ${chip.name}: ${chip.value}`}
          data-testid={`filter-chip-${chip.key}`}
          className="inline-flex min-h-6 items-center gap-1 rounded-full border bg-background py-0.5 pr-1.5 pl-2.5 text-xs outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring max-sm:min-h-9"
        >
          <span className="text-muted-foreground">{chip.name}:</span>
          <span className="max-w-48 truncate font-medium">{chip.value}</span>
          <XIcon aria-hidden className="size-3 text-muted-foreground" />
        </Link>
      ))}
      <Link href={clearHref} className={cn(buttonVariants({ variant: "ghost", size: "sm" }), "max-sm:h-11")}>
        Clear filters
      </Link>
    </div>
  );
}
