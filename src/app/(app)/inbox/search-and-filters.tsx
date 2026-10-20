"use client";

import { ChevronDownIcon } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";

/**
 * Search and the Filters button share one line, and the filter form opens below it. The server renders the search form, the
 * status slot (what waits in Actions) and the form itself, and passes them in; this component only holds whether the form is open.
 */
export function SearchAndFilters({ count, search, status, panel }: { count: number; search: ReactNode; status: ReactNode; panel: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        {search}
        <Button variant="outline" size="sm" aria-expanded={open} aria-controls="inbox-filters" onClick={() => setOpen((value) => !value)} className="max-sm:h-11 max-sm:px-4" data-testid="inbox-filters-toggle">
          Filters{count > 0 ? ` (${count})` : ""}
          <ChevronDownIcon aria-hidden className={open ? "rotate-180" : undefined} />
        </Button>
        {status}
      </div>
      {open && <div id="inbox-filters">{panel}</div>}
    </>
  );
}
