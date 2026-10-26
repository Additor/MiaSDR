import type { ReactNode } from "react";

/**
 * The one row between a list page's header and its list: what narrows the list on the left (chips, search, the Filters
 * popover), list options on the right. The chips of the filters in force (`AppliedFilters`) say what applies, so a
 * closed popover never hides a filter.
 */
export function ListToolbar({ children, filters, end }: { children?: ReactNode; filters?: ReactNode; end?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      {children}
      {filters}
      {end && <div className="flex flex-wrap items-center gap-2 sm:ml-auto">{end}</div>}
    </div>
  );
}
