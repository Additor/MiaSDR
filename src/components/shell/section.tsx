import type { ReactNode } from "react";
import { cn } from "@/components/ui/utils";

/**
 * A tally beside a heading, a chip or a list. `waiting` is work that waits on a person and takes the lavender count
 * (DESIGN.md Colors); everything else is a muted number. One size and weight everywhere: no capsule, no parentheses.
 */
export function Count({ value, tone = "neutral", className, testId }: { value: ReactNode; tone?: "neutral" | "waiting"; className?: string; testId?: string }) {
  return (
    <span className={cn("text-sm tabular-nums", tone === "waiting" ? "font-semibold text-sidebar-count" : "text-muted-foreground", className)} data-testid={testId}>
      {value}
    </span>
  );
}

/**
 * The head of a section: the heading in its role, an optional icon in front, a count and an info mark after it, the
 * description under it at field space, and an action at the end of the row. Every section of the app draws its head here.
 */
export function SectionHead({
  title,
  level = "h2",
  role = "section",
  id,
  icon,
  count,
  countTone,
  countTestId,
  help,
  description,
  action,
}: {
  title: ReactNode;
  level?: "h2" | "h3";
  /** `block` is the text-base head of a Settings block; `section` the head of a record, campaign or Actions section. */
  role?: "block" | "section";
  id?: string;
  icon?: ReactNode;
  count?: ReactNode;
  countTone?: "neutral" | "waiting";
  countTestId?: string;
  /** An `InfoTip` for a name that needs explaining. */
  help?: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
}) {
  const Heading = level;
  return (
    <div className="flex min-h-7 flex-wrap items-start justify-between gap-x-3 gap-y-2">
      {/* The text takes the row and wraps, so an action stays on the heading row beside a long description. */}
      <div className="stack-field min-w-0 flex-1 basis-64">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <Heading id={id} className={cn("flex items-center gap-1.5", role === "block" ? "heading-block" : "heading-section")}>
            {icon}
            {title}
          </Heading>
          {count !== undefined && count !== null && <Count value={count} tone={countTone} testId={countTestId} />}
          {help && <span className="self-center">{help}</span>}
        </div>
        {description && <div className="max-w-prose text-sm text-muted-foreground">{description}</div>}
      </div>
      {action}
    </div>
  );
}

/**
 * A section of a page, ruled apart from its neighbors by a hairline with section space on both sides, never boxed. The
 * first section of a stack drops its rule and top space, the last its bottom space. `plain` drops the rule and padding for
 * a section that sits in a grid of its own (the Actions lists); `inset` pads it for a side panel block.
 */
export function Section({
  frame = "ruled",
  className,
  children,
  sectionId,
  label,
  testId,
  sectionRole,
  flushEnd = true,
  ...head
}: Parameters<typeof SectionHead>[0] & {
  frame?: "ruled" | "plain" | "inset";
  /** The last ruled section drops its bottom space. Off where a disclosure or a list follows the stack and needs the space. */
  flushEnd?: boolean;
  className?: string;
  children?: ReactNode;
  /** The section's own id, for a jump link. */
  sectionId?: string;
  /** Names the section when its heading carries no id. */
  label?: string;
  testId?: string;
  sectionRole?: "status" | "alert";
}) {
  return (
    <section
      id={sectionId}
      aria-labelledby={label ? undefined : head.id}
      aria-label={label}
      role={sectionRole}
      data-testid={testId}
      className={cn(
        "stack-group min-w-0",
        frame === "ruled" && "border-t py-section first-of-type:border-t-0 first-of-type:pt-0",
        frame === "ruled" && flushEnd && "last-of-type:pb-0",
        frame === "plain" && "scroll-mt-4",
        frame === "inset" && "p-inset",
        className,
      )}
    >
      <SectionHead {...head} />
      {children}
    </section>
  );
}
