import type { ReactElement, ReactNode } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/**
 * A state with its secondary facts on hover and on keyboard focus. `trigger` is the focusable element (a link, or a span
 * with `tabIndex={0}`); `children` is its visible content. The tooltip is visual only, so the same facts sit in the
 * trigger as screen-reader text.
 */
export function StateTip({ trigger, tip, children }: { trigger: ReactElement; tip: ReactNode; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger delay={150} render={trigger}>
        {children}
        <span className="sr-only">
          {", "}
          {tip}
        </span>
      </TooltipTrigger>
      <TooltipContent className="block max-w-72 text-left leading-relaxed">{tip}</TooltipContent>
    </Tooltip>
  );
}

/** Lines of a tooltip, one fact each. Screen readers hear them as one sentence. */
export function TipLines({ lines }: { lines: ReactNode[] }) {
  const shown = lines.filter(Boolean);
  return (
    <>
      {shown.map((line, index) => (
        <span key={index} className="block">
          {line}
          {index < shown.length - 1 && <span className="sr-only">. </span>}
        </span>
      ))}
    </>
  );
}
