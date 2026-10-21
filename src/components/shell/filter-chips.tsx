import Link from "next/link";
import { cn } from "@/lib/utils";
import type { SwitchItem } from "./view-switch";

/**
 * Narrows what the page lists. Round chips with a filled active state, grouped rather than marked up as
 * navigation: a filter changes the list, it does not take you to another place.
 */
export function FilterChips({ label, items, className }: { label: string; items: SwitchItem[]; className?: string }) {
  return (
    <div role="group" aria-label={label} className={cn("flex flex-wrap items-center gap-1.5", className)}>
      {items.map((item, index) => (
        <Link
          key={index}
          href={item.href}
          aria-current={item.active ? "true" : undefined}
          data-testid={item.testId}
          className={cn(
            "inline-flex h-7 items-center rounded-full border px-3 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring max-sm:h-11 max-sm:px-4",
            item.active ? "border-transparent bg-primary font-medium text-primary-foreground" : "bg-background text-muted-foreground hover:bg-muted hover:text-foreground",
          )}
        >
          {item.label}
          {item.count !== undefined && <span className="ml-1.5 tabular-nums opacity-70">{item.count.toLocaleString("en-US")}</span>}
        </Link>
      ))}
    </div>
  );
}
