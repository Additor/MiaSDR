import Link from "next/link";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export interface SwitchItem {
  href: string;
  label: ReactNode;
  active: boolean;
  testId?: string;
  /** A count beside the label, in one style on every chip row. */
  count?: number;
}

/**
 * Switches between views of the same page, such as People and Companies. Underlined tabs, so it never reads as a
 * set of filters (chips) or actions (buttons). Each view has its own URL, so it is a navigation landmark.
 * Panels that switch client state without a URL (Tabs in shell/tabs.tsx, the workbook table strip) use real ARIA tabs instead.
 */
export function ViewSwitch({ label, items, className }: { label: string; items: SwitchItem[]; className?: string }) {
  return (
    <nav aria-label={label} className={cn("flex max-w-full min-w-0 gap-1 overflow-x-auto border-b", className)}>
      {items.map((item, index) => (
        <Link
          key={index}
          href={item.href}
          aria-current={item.active ? "page" : undefined}
          data-testid={item.testId}
          className={cn(
            "-mb-px flex min-h-9 items-center border-b-2 px-3 text-sm whitespace-nowrap outline-none focus-visible:ring-2 focus-visible:ring-ring",
            item.active ? "border-foreground font-medium text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
          )}
        >
          {item.label}
        </Link>
      ))}
    </nav>
  );
}
