import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * A block of the campaign page: an h2 with an optional count, description and action, then its content. Blocks are ruled
 * apart by a hairline like `RecordSection`, not boxed. The first block of a group drops its rule and top space, the last
 * its bottom space, so a group sits in the page stack without extra gaps.
 */
export function CampaignSection({
  title,
  icon,
  count,
  description,
  action,
  level = "h2",
  id,
  testId,
  role,
  className,
  children,
}: {
  title: ReactNode;
  /** A lucide icon in front of the title, for a notice. */
  icon?: ReactNode;
  count?: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  level?: "h2" | "h3";
  id?: string;
  testId?: string;
  role?: "status" | "alert";
  className?: string;
  children?: ReactNode;
}) {
  const Heading = level;
  return (
    <section id={id} role={role} data-testid={testId} className={cn("stack-group min-w-0 border-t py-section first:border-t-0 first:pt-0 last:pb-0", className)}>
      <div className="flex min-h-7 flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <div className="stack-field min-w-0">
          <div className="flex items-baseline gap-2">
            <Heading className="flex items-center gap-1.5 text-sm font-semibold">
              {icon}
              {title}
            </Heading>
            {count !== undefined && count !== null && <span className="text-sm text-muted-foreground tabular-nums">{count}</span>}
          </div>
          {description && <div className="max-w-prose text-sm text-muted-foreground">{description}</div>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}
