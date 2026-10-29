import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/components/ui/utils";

/**
 * What a list shows while its rows stream in: rows of the height the real ones take, a name and a line under it, so the page
 * does not jump when the list arrives. `bordered` frames the rows like the Actions groups; the Inbox table has none.
 * It is one status region, so a screen reader hears "Loading" once.
 */
export function ListSkeleton({ rows = 6, bordered = false, toolbar = true, label = "Loading" }: { rows?: number; bordered?: boolean; toolbar?: boolean; label?: string }) {
  return (
    <div role="status" aria-label={label} className="stack-group" data-testid="list-skeleton">
      {/* The toolbar row: a search and a button, the parts every list toolbar has. A list without one passes `toolbar={false}`. */}
      {toolbar && (
        <div className="flex gap-2">
          <Skeleton className="h-8 w-56 max-w-[60%]" />
          <Skeleton className="h-8 w-20" />
        </div>
      )}
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
