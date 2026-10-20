import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

/**
 * What a list shows while its rows stream in: rows of the height the real ones take, a name and a line under it, so the page
 * does not jump when the list arrives. `bordered` frames the rows like the Actions groups; the Inbox table has none.
 * It is one status region, so a screen reader hears "Loading" once.
 */
export function ListSkeleton({ rows = 6, bordered = false, label = "Loading" }: { rows?: number; bordered?: boolean; label?: string }) {
  return (
    <div role="status" aria-label={label} className="grid gap-3" data-testid="list-skeleton">
      <div className="flex gap-2">
        <Skeleton className="h-7 w-14 rounded-full" />
        <Skeleton className="h-7 w-16 rounded-full" />
        <Skeleton className="h-7 w-20 rounded-full" />
      </div>
      <ul className={cn("divide-y", bordered && "rounded-lg border")}>
        {Array.from({ length: rows }, (_, index) => (
          <li key={index} className="grid gap-2 px-3 py-3 sm:py-2.5">
            <div className="flex items-center justify-between gap-3">
              <Skeleton className="h-4 w-40 max-w-[55%]" />
              <Skeleton className="h-3 w-16" />
            </div>
            <Skeleton className="h-4 w-full max-w-lg" />
          </li>
        ))}
      </ul>
    </div>
  );
}
