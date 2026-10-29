"use client";

import type { ReactNode } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/**
 * A cell's state mark or hint. The active cell opens its reason in a tooltip; every other cell draws the mark alone,
 * because the grid renders thousands of cells. The reason also sits in the cell's accessible description.
 */
export function CellTip({ active, tip, className, children }: { active: boolean; tip?: string; className?: string; children: ReactNode }) {
  if (!active || !tip) return <span className={className}>{children}</span>;
  return (
    <Tooltip>
      <TooltipTrigger render={<span className={className} />}>{children}</TooltipTrigger>
      <TooltipContent>{tip}</TooltipContent>
    </Tooltip>
  );
}
