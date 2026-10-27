"use client";

import { cloneElement, type ReactElement, type ReactNode } from "react";
import { useMediaQuery } from "@/components/hooks/use-media-query";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/components/ui/utils";

/**
 * Secondary text on a trigger: a tooltip on hover and keyboard focus where the device can hover, and a popover that
 * opens on a tap where it cannot (`hover: none`), because a tooltip never opens on touch. `trigger` is the focusable
 * element, a span with `tabIndex={0}` or a button; a link navigates on tap, so keep link triggers on `Tooltip`.
 * `children` is the trigger's content and carries its own screen-reader text.
 */
export function TouchTip({ trigger, tip, children, className }: { trigger: ReactElement<{ role?: string }>; tip: ReactNode; children: ReactNode; className?: string }) {
  const touch = useMediaQuery("(hover: none)", false);
  const body = cn("block max-w-72 text-left leading-relaxed", className);
  if (touch) {
    // The trigger opens a popover here, so it is a button to assistive tech, not the note it is on hover devices.
    const button = trigger.props.role === "note" ? cloneElement(trigger, { role: "button" }) : trigger;
    return (
      <Popover>
        <PopoverTrigger nativeButton={trigger.type === "button"} render={button}>
          {children}
        </PopoverTrigger>
        <PopoverContent tip className={cn("px-3 py-2 text-xs", body)}>
          {tip}
        </PopoverContent>
      </Popover>
    );
  }
  return (
    <Tooltip>
      <TooltipTrigger delay={150} render={trigger}>
        {children}
      </TooltipTrigger>
      <TooltipContent className={body}>{tip}</TooltipContent>
    </Tooltip>
  );
}
