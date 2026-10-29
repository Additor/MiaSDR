import { XIcon } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/components/ui/utils";

/** One filter or sort in force. A list passes `href`, the same list without it; a table passes `onRemove`. */
export interface AppliedFilter {
  key: string;
  /** The filter's name, or none when `value` reads as a whole ("Name contains Ada"). */
  name?: string;
  value: string;
  href?: string;
  onRemove?: () => void;
  /** A table condition kept in the view that filters nothing. */
  muted?: boolean;
}

const CHIP =
  "inline-flex min-h-6 items-center gap-1 rounded-full border bg-background py-0.5 pr-1.5 pl-2.5 text-xs hover:bg-muted focus-ring max-sm:min-h-11";

export function FilterChip({ chip }: { chip: AppliedFilter }) {
  const said = chip.name ? `${chip.name}: ${chip.value}` : chip.value;
  const content = (
    <>
      {chip.name && <span className="text-muted-foreground">{chip.name}:</span>}
      <span className={cn("max-w-64 truncate font-medium", chip.muted && "text-muted-foreground line-through")}>{chip.value}</span>
      <XIcon aria-hidden className="size-3 text-muted-foreground" />
    </>
  );
  const props = { "aria-label": `Remove filter ${said}`, "data-testid": `filter-chip-${chip.key}`, className: CHIP };
  return chip.href ? (
    <Link href={chip.href} {...props}>
      {content}
    </Link>
  ) : (
    <button type="button" onClick={chip.onRemove} {...props}>
      {content}
    </button>
  );
}

/**
 * The filters and sorts in force as removable chips under the toolbar, with one Clear filters at the end. A closed
 * Filters popover never hides a filter, because these chips say what applies. `extra` sits after the chips, such as a
 * table's Match all or any.
 */
export function AppliedFilters({ chips, clear, extra }: { chips: AppliedFilter[]; clear: { href: string } | { onClick: () => void }; extra?: ReactNode }) {
  if (chips.length === 0) return null;
  const clearClass = buttonVariants({ variant: "ghost", size: "sm", touch: true });
  return (
    <div role="group" aria-label="Applied filters" className="flex flex-wrap items-center gap-1.5">
      {chips.map((chip) => (
        <FilterChip key={chip.key} chip={chip} />
      ))}
      {extra}
      {"href" in clear ? (
        <Link href={clear.href} className={clearClass}>
          Clear filters
        </Link>
      ) : (
        <button type="button" onClick={clear.onClick} className={clearClass}>
          Clear filters
        </button>
      )}
    </div>
  );
}
