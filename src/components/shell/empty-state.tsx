import Link from "next/link";
import type { ReactNode } from "react";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/components/ui/utils";

/**
 * Nothing to show yet. Name what is missing in the title and say what to do next in the description. `action` is a link
 * (`{ label, href }`) or any node, such as a button that opens a dialog. It draws no box of its own, so it sits in a
 * Settings block, on a page, or under a table header. Under a section heading, pass `py-0` so the heading stays closer
 * to its content than to the block above.
 */
export function EmptyState({ title, description, action, className }: { title: string; description?: string; action?: { label: string; href: string } | ReactNode; className?: string }) {
  return (
    <div className={cn("grid justify-items-start gap-2 py-8 text-sm", className)}>
      <p className="font-medium">{title}</p>
      {description && <p className="max-w-prose text-muted-foreground">{description}</p>}
      {action && <div className="mt-1">{isLink(action) ? <Link href={action.href} className={buttonVariants({ variant: "outline" })}>{action.label}</Link> : action}</div>}
    </div>
  );
}

function isLink(action: unknown): action is { label: string; href: string } {
  return typeof action === "object" && action !== null && "href" in action && "label" in action && !("$$typeof" in action);
}
