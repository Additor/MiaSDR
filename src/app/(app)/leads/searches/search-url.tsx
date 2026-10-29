"use client";

import { TouchTip } from "@/components/shell/touch-tip";
import { cn } from "@/components/ui/utils";

/** A search URL without the LinkedIn host, cut to one line. The whole URL shows on hover, keyboard focus or a tap. */
export function SearchUrl({ url, className }: { url: string; className?: string }) {
  return (
    <TouchTip trigger={<span tabIndex={0} role="note" className={cn("block max-w-full min-w-0 truncate rounded-sm text-xs text-muted-foreground focus-ring", className)} />} tip={<span className="break-all">{url}</span>}>
      {url.replace(/^https:\/\/www\.linkedin\.com/, "")}
    </TouchTip>
  );
}
