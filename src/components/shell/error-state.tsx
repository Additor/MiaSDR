import type { ReactNode } from "react";
import { cn } from "@/components/ui/utils";

/**
 * Something did not load. The title says what is missing in the foreground, the reason follows in red text, and the
 * action offers the way back (Try again, Reload). Like `EmptyState` it draws no box, so it takes the place of the content
 * it stands for. `inline` drops the vertical padding for a failure inside a section or a drawer.
 */
export function ErrorState({
  title,
  reason,
  action,
  inline = false,
  className,
  testId,
}: {
  title: string;
  /** The error text, as the server or the request gave it. */
  reason?: ReactNode;
  action?: ReactNode;
  inline?: boolean;
  className?: string;
  testId?: string;
}) {
  return (
    <div role="alert" className={cn("grid justify-items-start gap-2 text-sm", !inline && "py-8", className)} data-testid={testId}>
      <p className="font-medium">{title}</p>
      {reason && <p className="max-w-prose text-destructive">{reason}</p>}
      {action && <div className="mt-1">{action}</div>}
    </div>
  );
}
