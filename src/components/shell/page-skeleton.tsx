import { Skeleton } from "@/components/ui/skeleton";
import { ListSkeleton } from "./list-skeleton";

/**
 * What a page shows while it streams in, in the shape of the page that follows, so it does not jump when the content
 * arrives. One status region, so a screen reader hears the label once.
 *
 * - `list`: a list page (`ListSkeleton` with its toolbar).
 * - `record`: a record page, a header and a work column beside a bordered side panel.
 * - `form`: a Settings page or a form, blocks of a heading and fields.
 * - `table`: a full-height grid, a toolbar over a bordered block.
 */
export function PageSkeleton({ shape, label = "Loading" }: { shape: "list" | "record" | "form" | "table"; label?: string }) {
  if (shape === "list") return <ListSkeleton label={label} />;
  return (
    <div role="status" aria-label={label} data-testid="page-skeleton" className="stack-section">
      {shape === "record" && (
        <>
          <div className="stack-field">
            <Skeleton className="h-7 w-64 max-w-[70%]" />
            <Skeleton className="h-4 w-48 max-w-[50%]" />
          </div>
          <div className="grid gap-section lg:grid-cols-[minmax(0,1fr)_20rem] xl:grid-cols-[minmax(0,1fr)_22rem]">
            <div className="stack-group">
              <Skeleton className="h-5 w-32" />
              <Skeleton className="h-24 w-full" />
              <Skeleton className="h-5 w-40" />
              <Skeleton className="h-16 w-full" />
            </div>
            <div className="stack-group rounded-lg border p-inset">
              <Skeleton className="h-5 w-24" />
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-3/4" />
            </div>
          </div>
        </>
      )}
      {shape === "form" &&
        Array.from({ length: 2 }, (_, block) => (
          <div key={block} className="stack-group max-w-3xl">
            <Skeleton className="h-5 w-40" />
            <div className="stack-field">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-8 w-full" />
            </div>
            <div className="stack-field">
              <Skeleton className="h-4 w-28" />
              <Skeleton className="h-8 w-full" />
            </div>
          </div>
        ))}
      {shape === "table" && (
        <div className="stack-group">
          <div className="flex gap-2">
            <Skeleton className="h-8 w-48" />
            <Skeleton className="h-8 w-20" />
            <Skeleton className="ml-auto h-8 w-24" />
          </div>
          <Skeleton className="h-96 w-full rounded-lg" />
        </div>
      )}
    </div>
  );
}
