import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/components/ui/utils";
import { LeadNavKeys } from "./lead-nav-keys";

/**
 * Previous and next lead in the list the person came from, in the top bar where they stay put from lead to lead, as Next in
 * queue does on a thread. `[` and `]` follow them. Absent when there is no list context.
 */
export function LeadNav({ prevHref, nextHref }: { prevHref: string | null; nextHref: string | null }) {
  const link = cn(buttonVariants({ variant: "outline", size: "icon-sm" }), "max-sm:size-11");
  const off = cn(link, "pointer-events-none opacity-50");
  return (
    <nav aria-label="Leads in this list" className="flex items-center gap-1">
      <LeadNavKeys prevHref={prevHref} nextHref={nextHref} />
      {prevHref ? (
        <Link href={prevHref} className={link} rel="prev" aria-keyshortcuts="[" title="Previous lead ([)">
          <ChevronLeftIcon aria-hidden />
          <span className="sr-only">Previous lead</span>
        </Link>
      ) : (
        <span aria-disabled="true" className={off} title="This is the first lead in the list">
          <ChevronLeftIcon aria-hidden />
          <span className="sr-only">Previous lead, none: this is the first in the list</span>
        </span>
      )}
      {nextHref ? (
        <Link href={nextHref} className={link} rel="next" aria-keyshortcuts="]" title="Next lead (])">
          <ChevronRightIcon aria-hidden />
          <span className="sr-only">Next lead</span>
        </Link>
      ) : (
        <span aria-disabled="true" className={off} title="This is the last lead in the list">
          <ChevronRightIcon aria-hidden />
          <span className="sr-only">Next lead, none: this is the last in the list</span>
        </span>
      )}
    </nav>
  );
}
