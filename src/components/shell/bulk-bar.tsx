"use client";

import type { ReactNode, Ref } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/utils";

/**
 * The selection bar under a list or a table. It sticks to the bottom of the viewport, in the thumb zone on a phone, and
 * its wrapper keeps the height of one row of controls whether or not anything is ticked, so ticking a row never moves the
 * rows above it. The status line is always mounted, so a screen reader hears the count as it changes.
 *
 * The bar holds the "{n} selected." line, then at most four controls: the bulk `actions` first, Clear selection, then
 * `more` (a `DropdownMenu` that opens with `side="top"`). On a phone the count and Clear share the first row and the
 * actions take the second, each 44px tall. `sticky={false}` sets the bar in the flow above a grid (Tables).
 */
export function BulkBar({
  count,
  status,
  note,
  error,
  actions,
  more,
  onClear,
  sticky = true,
  barRef,
  testId = "selection-bar",
}: {
  count: number;
  /** The status line; defaults to "{n} selected.". */
  status?: ReactNode;
  /** A muted line under the status, such as a cap on what the selection reaches. */
  note?: ReactNode;
  error?: ReactNode;
  actions?: ReactNode;
  more?: ReactNode;
  onClear?: () => void;
  sticky?: boolean;
  barRef?: Ref<HTMLDivElement>;
  testId?: string;
}) {
  const on = count > 0;
  return (
    // In the flow above a grid, an empty bar takes no room: the wrapper lets its child sit in the parent's stack, and the
    // status line stays mounted off screen so the count is still announced.
    <div ref={barRef} className={cn(sticky ? "sticky bottom-0 z-30 min-h-14 pb-[env(safe-area-inset-bottom)]" : !on && "contents")} data-testid={testId}>
      <div className={cn("flex flex-wrap items-center gap-2 rounded-lg px-3 py-2 text-sm", on && "border bg-background shadow-md ring-1 ring-foreground/5", !on && !sticky && "sr-only")}>
        <div role="status" className="max-md:order-1 max-md:min-h-11 max-md:flex-1 max-md:content-center md:mr-1">
          {on && (
            <>
              {status ?? `${count.toLocaleString("en-US")} selected.`}
              {note && <span className="block text-xs text-muted-foreground">{note}</span>}
            </>
          )}
        </div>
        {on && error && (
          <span role="alert" className="basis-full text-destructive max-md:order-7">
            {error}
          </span>
        )}
        {on && (
          <>
            <div aria-hidden className="-mb-2 hidden basis-full max-md:order-3 max-md:block" />
            {actions && <div className="flex flex-wrap gap-2 max-md:order-4 max-md:flex-1 max-md:[&>*]:h-11 max-md:[&>*]:flex-1">{actions}</div>}
            {onClear && (
              <Button variant="ghost" className="text-muted-foreground max-md:order-2 max-md:h-11" onClick={onClear}>
                Clear selection
              </Button>
            )}
            {more && <div className="max-md:order-6 md:ml-auto">{more}</div>}
          </>
        )}
      </div>
    </div>
  );
}
