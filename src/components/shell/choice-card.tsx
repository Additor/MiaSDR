import type { ReactNode } from "react";
import { RadioGroupItem } from "@/components/ui/radio-group";
import { cn } from "@/components/ui/utils";

/**
 * The frame of a choice that needs more than a label: a company to merge into, a person to file a sender under. A
 * hairline box, 44px tall at least, that takes the ring border and a muted ground while its control is checked. It works
 * with the app's `RadioGroupItem` and `Checkbox`, which set `data-checked`.
 */
export const CHOICE_CARD = "flex min-h-11 cursor-pointer items-center gap-2 rounded-lg border p-2 text-sm leading-normal font-normal transition-colors hover:bg-muted/30 has-data-checked:border-ring has-data-checked:bg-muted/50 has-disabled:cursor-not-allowed has-disabled:opacity-50";

/**
 * A tile that opens a choice rather than holding one: the four enrichment outcomes. A button with the name, a muted
 * sentence and a line of state, the same border and focus ring as the inputs.
 */
export const CHOICE_TILE =
  "grid h-full w-full content-start gap-1 rounded-lg border p-3 text-left transition-colors hover:bg-muted/50 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none";

/** One option of a `RadioGroup` drawn as a card: the radio, then the content, then a trailing mark such as a badge. */
export function ChoiceCard({ id, value, children, trailing, className }: { id: string; value: string; children: ReactNode; trailing?: ReactNode; className?: string }) {
  return (
    <label htmlFor={id} className={cn(CHOICE_CARD, className)}>
      <RadioGroupItem value={value} id={id} />
      <span className="min-w-0 flex-1 break-words">{children}</span>
      {trailing}
    </label>
  );
}
