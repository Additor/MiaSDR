"use client";

import { SlidersHorizontalIcon } from "lucide-react";
import { useId, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";

/**
 * The one row between a list page's header and its list: what narrows the list on the left (chips, search, the Filters
 * button), list options on the right. Filters opens a panel under the row and starts closed; the chips of the filters in
 * force (`ActiveFilterChips`) say what applies, so a closed panel never hides a filter. The panel stays in the DOM while
 * closed, so a form that wraps the toolbar still submits its fields.
 */
export function ListToolbar({ children, filters, end }: { children?: ReactNode; filters?: { count: number; panel: ReactNode }; end?: ReactNode }) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap items-center gap-2">
        {children}
        {filters && (
          <Button type="button" variant="outline" size="sm" aria-expanded={open} aria-controls={panelId} onClick={() => setOpen((value) => !value)} className="max-sm:h-11 max-sm:px-4" data-testid="filters-toggle">
            <SlidersHorizontalIcon aria-hidden />
            Filters
            {filters.count > 0 && (
              <span className="rounded-full bg-primary px-1.5 text-xs leading-5 font-medium text-primary-foreground tabular-nums">
                {filters.count}
                <span className="sr-only"> in use</span>
              </span>
            )}
          </Button>
        )}
        {end && <div className="flex flex-wrap items-center gap-2 sm:ml-auto">{end}</div>}
      </div>
      {filters && (
        <div id={panelId} hidden={!open}>
          {filters.panel}
        </div>
      )}
    </div>
  );
}
