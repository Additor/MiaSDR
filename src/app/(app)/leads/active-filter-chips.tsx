import Link from "next/link";
import { XIcon } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import type { LeadFilter, LeadSort } from "@/contexts/leads/domain/lead-filter";
import { cn } from "@/lib/utils";
import type { FilterChip } from "./active-filters";
import { leadsHref } from "./list-url";

/**
 * The applied filters as removable chips above the list, with the one Clear filters link. Each chip is a link to
 * the same list without that filter, so removing one needs no script and goes back to page 1.
 */
export function ActiveFilters({ chips, sort, size }: { chips: FilterChip[]; sort: LeadSort; size: number }) {
  if (chips.length === 0) return null;
  const hrefWithout = (without: LeadFilter) => leadsHref({ filter: without, sort, size });
  return (
    <div role="group" aria-label="Applied filters" className="flex flex-wrap items-center gap-1.5">
      {chips.map((chip) => (
        <Link
          key={chip.key}
          href={hrefWithout(chip.without)}
          aria-label={`Remove filter ${chip.name}: ${chip.value}`}
          data-testid={`filter-chip-${chip.key}`}
          className="inline-flex min-h-6 items-center gap-1 rounded-full border bg-background py-0.5 pr-1.5 pl-2.5 text-xs outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span className="text-muted-foreground">{chip.name}:</span>
          <span className="max-w-48 truncate font-medium">{chip.value}</span>
          <XIcon aria-hidden className="size-3 text-muted-foreground" />
        </Link>
      ))}
      <Link href={hrefWithout({})} className={cn(buttonVariants({ variant: "ghost", size: "sm" }))}>
        Clear filters
      </Link>
    </div>
  );
}
