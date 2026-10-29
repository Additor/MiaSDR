import { ArrowDownIcon } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/components/ui/utils";

/**
 * "12 contacts" and, when there is more than one page, "page 2 of 3" with Previous and Next links. A one-page list
 * shows the count alone. `hrefFor` builds the URL of another page of the same list. `size` is an optional page size
 * control that sits beside the links and stays on a one-page list, so a larger size can be undone.
 */
export function ListPager({ total, page, pageCount, noun, hrefFor, size }: { total: number; page: number; pageCount: number; noun: [string, string]; hrefFor: (page: number) => string; size?: ReactNode }) {
  const count = `${total.toLocaleString("en-US")} ${total === 1 ? noun[0] : noun[1]}`;
  if (pageCount <= 1 && page <= 1) {
    if (!size) return <p className="text-sm text-muted-foreground tabular-nums">{count}</p>;
    return (
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-muted-foreground tabular-nums">
        <span>{count}</span>
        {size}
      </div>
    );
  }
  const link = cn(buttonVariants({ variant: "ghost", size: "sm" }), "max-sm:h-11 max-sm:px-4");
  const off = cn(link, "pointer-events-none opacity-50");
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-muted-foreground tabular-nums">
      <span>{`${count}, page ${page} of ${pageCount}`}</span>
      <div className="flex items-center gap-2">
        {size}
        <nav aria-label="Pages" className="flex items-center gap-1">
          {page > 1 ? (
            <Link href={hrefFor(Math.min(page - 1, pageCount))} className={link} rel="prev">
              Previous
            </Link>
          ) : (
            <span aria-disabled="true" className={off}>
              Previous
            </span>
          )}
          {page < pageCount ? (
            <Link href={hrefFor(page + 1)} className={link} rel="next">
              Next
            </Link>
          ) : (
            <span aria-disabled="true" className={off}>
              Next
            </span>
          )}
        </nav>
      </div>
    </div>
  );
}

/** A column header that sorts the list. A second click on the active column returns to the list's default order. */
export function SortHeader({ label, active, href, sortKey }: { label: string; active: boolean; href: string; sortKey: string }) {
  return (
    <Link href={href} className="inline-flex items-center gap-1 hover:underline max-sm:min-h-11" data-sort-key={sortKey} aria-label={active ? `${label}, sorted. Sort by the default order` : `Sort by ${label.toLowerCase()}`}>
      {label}
      {active && <ArrowDownIcon aria-hidden className="size-3.5 text-muted-foreground" />}
    </Link>
  );
}

export const pageCountOf = (total: number, pageSize: number) => Math.max(1, Math.ceil(total / pageSize));
