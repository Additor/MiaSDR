import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { buttonVariants } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { OffAction } from "@/app/(app)/_components/off-action";
import { LeadNavKeys } from "./lead-nav-keys";

/**
 * Previous and next lead in the list the person came from, in the top bar where they stay put from lead to lead, as Next in
 * queue does on a thread. `[` and `]` follow them. Absent when there is no list context. At an end of the list the control
 * stays in place, off, and says why on hover, focus or a tap.
 */
export function LeadNav({ prevHref, nextHref }: { prevHref: string | null; nextHref: string | null }) {
  return (
    <nav aria-label="Leads in this list" className="flex items-center gap-1">
      <LeadNavKeys prevHref={prevHref} nextHref={nextHref} />
      {prevHref ? (
        <NavLink href={prevHref} rel="prev" shortcut="[" name="Previous lead">
          <ChevronLeftIcon aria-hidden />
        </NavLink>
      ) : (
        <OffAction size="icon-sm" reason="This is the first lead in the list.">
          <ChevronLeftIcon aria-hidden />
          <span className="sr-only">Previous lead</span>
        </OffAction>
      )}
      {nextHref ? (
        <NavLink href={nextHref} rel="next" shortcut="]" name="Next lead">
          <ChevronRightIcon aria-hidden />
        </NavLink>
      ) : (
        <OffAction size="icon-sm" reason="This is the last lead in the list.">
          <ChevronRightIcon aria-hidden />
          <span className="sr-only">Next lead</span>
        </OffAction>
      )}
    </nav>
  );
}

/** An icon link with its name and key in a tooltip. A tap navigates, so a link keeps the tooltip and no popover. */
function NavLink({ href, rel, shortcut, name, children }: { href: string; rel: string; shortcut: string; name: string; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger delay={150} render={<Link href={href} className={buttonVariants({ variant: "outline", size: "icon-sm", touch: true })} rel={rel} aria-keyshortcuts={shortcut} />}>
        {children}
        <span className="sr-only">{name}</span>
      </TooltipTrigger>
      <TooltipContent>
        {name} ({shortcut})
      </TooltipContent>
    </Tooltip>
  );
}
