import Link from "next/link";
import type { ComponentProps } from "react";
import { cn } from "cn";

/**
 * Whole-row navigation without a click handler on the row. The primary text link stretches over the row through an
 * `after:` pseudo-element, so a click anywhere opens the detail page, keyboard users tab to one real link, and screen
 * readers announce one link per row.
 *
 * Put `rowLinkClasses` on the `<tr>` (through `TableRow`'s `className`) or on the card, and `RowLink` around the main text:
 *
 *   <TableRow className={rowLinkClasses}><TableCell><RowLink href={`/leads/${id}`}>{name}</RowLink></TableCell>...
 *
 * Buttons, links, checkboxes and menus inside the row need `relative z-10` so they sit above the stretched hit area and
 * keep their own clicks.
 */
export const rowLinkClasses = "relative cursor-pointer hover:bg-muted/50 focus-within:outline-2 focus-within:-outline-offset-2 focus-within:outline-ring";

export function RowLink({ className, ...props }: ComponentProps<typeof Link>) {
  return <Link className={cn("font-medium outline-none after:absolute after:inset-0 hover:underline focus-visible:underline", className)} {...props} />;
}
