import Link from "next/link";
import { cn } from "@/components/ui/utils";
import { formatCount } from "@/shared/format-number";
import type { SwitchItem } from "./view-switch";

/**
 * Narrows what the page lists: one segmented control, the same frame as `TristateField`, with the active segment on a
 * muted ground at medium weight. Grouped rather than marked up as navigation: a filter changes the list, it does not take
 * you to another place. Round pills stay for the applied filters you remove (`FilterChip`), so a toolbar has one meaning
 * per shape. A row too long for a phone scrolls sideways inside the frame.
 */
export function FilterChips({ label, items, className }: { label: string; items: SwitchItem[]; className?: string }) {
  return (
    <div role="group" aria-label={label} className={cn("inline-flex max-w-full items-center gap-0.5 overflow-x-auto rounded-lg border border-input p-0.5 dark:bg-input/30", className)}>
      {items.map((item, index) => (
        <Link
          key={index}
          href={item.href}
          aria-current={item.active ? "true" : undefined}
          data-testid={item.testId}
          className={cn(
            "inline-flex h-6 shrink-0 items-center rounded-md px-2.5 text-xs whitespace-nowrap outline-none focus-visible:ring-3 focus-visible:ring-ring/50 max-sm:h-11",
            item.active ? "bg-muted font-medium text-foreground" : "text-muted-foreground hover:text-foreground",
          )}
        >
          {item.label}
          {item.count !== undefined && <span className="ml-1.5 text-muted-foreground tabular-nums">{formatCount(item.count)}</span>}
        </Link>
      ))}
    </div>
  );
}
