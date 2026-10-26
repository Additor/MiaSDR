import type { ReactNode } from "react";
import { cn } from "cn";

/**
 * Wraps a `Table` so it scrolls sideways on narrow screens and shows where the
 * hidden columns are: a soft shadow on each edge that still has content to scroll to.
 * The table primitive owns the scroll container, so the shadows target it by slot.
 */
const SCROLL_CUE = [
  "min-w-0",
  "[&_[data-slot=table-container]]:[background-image:linear-gradient(to_right,var(--background),var(--background)),linear-gradient(to_left,var(--background),var(--background)),linear-gradient(to_right,color-mix(in_oklab,var(--foreground)_14%,transparent),transparent),linear-gradient(to_left,color-mix(in_oklab,var(--foreground)_14%,transparent),transparent)]",
  "[&_[data-slot=table-container]]:[background-position:left_center,right_center,left_center,right_center]",
  "[&_[data-slot=table-container]]:[background-size:24px_100%,24px_100%,12px_100%,12px_100%]",
  "[&_[data-slot=table-container]]:[background-repeat:no-repeat]",
  "[&_[data-slot=table-container]]:[background-attachment:local,local,scroll,scroll]",
].join(" ");

export function ScrollableTable({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div data-slot="scrollable-table" className={cn(SCROLL_CUE, className)}>
      {children}
    </div>
  );
}
