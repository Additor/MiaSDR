"use client";

import { CheckIcon, ChevronDownIcon } from "lucide-react";
import Link from "next/link";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

export interface MoreView {
  href: string;
  label: string;
  active: boolean;
}

/**
 * The views that are rarely the first thing to open (Sent, Replied, Out of office, Automated) behind one chip next to the
 * others. While one of them is in force the chip carries its name and takes the active look, so the list never reads as
 * unfiltered. Each item is a link with its own URL.
 */
export function MoreViews({ items }: { items: MoreView[] }) {
  const current = items.find((item) => item.active);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        data-testid="more-views"
        className={cn(
          "inline-flex h-7 items-center gap-1 rounded-full border px-3 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring max-sm:h-11 max-sm:px-4",
          current ? "border-transparent bg-primary font-medium text-primary-foreground" : "bg-background text-muted-foreground hover:bg-muted hover:text-foreground",
        )}
      >
        {current ? current.label : "More"}
        <ChevronDownIcon aria-hidden className="size-3" />
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-44" align="start">
        {items.map((item) => (
          <DropdownMenuItem key={item.label} render={<Link href={item.href} aria-current={item.active ? "true" : undefined} />}>
            {item.label}
            {item.active && <CheckIcon aria-hidden className="ml-auto size-3.5" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
