import type { ReactNode } from "react";

/**
 * One block of a Settings page: a text-base heading with an optional one-line description, then its content by group.
 * Blocks sit in one column and a hairline with section space rules them apart; the first block has neither. A form
 * lives inside its block and ends with its own Save button, with no footer band.
 */
export function SettingsSection({
  title,
  description,
  action,
  id,
  testId,
  children,
}: {
  title: ReactNode;
  description?: ReactNode;
  /** A control on the heading row, such as Add. */
  action?: ReactNode;
  /** Names the section for `aria-labelledby`. */
  id?: string;
  testId?: string;
  children?: ReactNode;
}) {
  return (
    <section
      aria-labelledby={id}
      data-testid={testId}
      className="stack-group border-t py-section first-of-type:border-t-0 first-of-type:pt-0 last-of-type:pb-0"
    >
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        {/* The text takes the row and wraps, so an action stays on the heading row beside a long description. */}
        <div className="stack-field min-w-0 flex-1 basis-64">
          <h2 id={id} className="text-base font-semibold">
            {title}
          </h2>
          {description && <div className="text-sm text-muted-foreground">{description}</div>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

/** A ruled list of items inside a block (mailboxes, documents, stages): hairlines between rows, no box around them. */
export const RULED_LIST = "divide-y";

/** One row of a ruled list. The first row starts at the heading's group gap and the last row ends flush. */
export const RULED_ROW = "py-3 first:pt-0 last:pb-0";
