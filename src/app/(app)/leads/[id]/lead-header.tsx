import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** Previous and next lead in the list the person came from. Absent when there is no list context. */
export function LeadNav({ prevHref, nextHref }: { prevHref: string | null; nextHref: string | null }) {
  const size = "max-sm:h-11 max-sm:px-3";
  const off = cn(buttonVariants({ variant: "outline", size: "sm" }), size, "pointer-events-none opacity-50");
  return (
    <nav aria-label="Leads in this list" className="flex items-center gap-2">
      {prevHref ? (
        <Link href={prevHref} className={cn(buttonVariants({ variant: "outline", size: "sm" }), size)} rel="prev">
          <ChevronLeftIcon aria-hidden />
          Previous
          <span className="sr-only"> lead</span>
        </Link>
      ) : (
        <span aria-disabled="true" className={off} title="This is the first lead in the list">
          <ChevronLeftIcon aria-hidden />
          Previous
          <span className="sr-only"> lead, none: this is the first in the list</span>
        </span>
      )}
      {nextHref ? (
        <Link href={nextHref} className={cn(buttonVariants({ variant: "outline", size: "sm" }), size)} rel="next">
          Next
          <span className="sr-only"> lead</span>
          <ChevronRightIcon aria-hidden />
        </Link>
      ) : (
        <span aria-disabled="true" className={off} title="This is the last lead in the list">
          Next
          <span className="sr-only"> lead, none: this is the last in the list</span>
          <ChevronRightIcon aria-hidden />
        </span>
      )}
    </nav>
  );
}
