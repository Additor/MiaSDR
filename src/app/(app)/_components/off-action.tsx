"use client";

import type { ReactNode } from "react";
import { TouchTip } from "@/components/shell/touch-tip";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/components/ui/utils";

/**
 * An action that is off, with the reason it is off. It keeps the outline button's shape so it sits where the working
 * control would, stays focusable (`aria-disabled`, not `disabled`) so the reason shows on hover and keyboard focus, and
 * opens the reason in a popover on a tap. The reason also sits in the button as screen-reader text, so its accessible
 * name reads "{label}, {reason}". Leads and Contacts use it for Export with nothing to export; a lead page for Previous
 * and Next at the ends of the list.
 */
export function OffAction({ reason, size = "sm", children }: { reason: string; size?: "sm" | "icon-sm"; children: ReactNode }) {
  return (
    <TouchTip trigger={<button type="button" aria-disabled="true" className={cn(buttonVariants({ variant: "outline", size, touch: true }), "cursor-not-allowed opacity-50")} />} tip={reason}>
      {children}
      <span className="sr-only">
        {", "}
        {reason}
      </span>
    </TouchTip>
  );
}
