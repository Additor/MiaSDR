import type { ReactNode } from "react";
import { Section } from "@/components/shell/section";

/**
 * One block of a Settings page: a text-base heading with an optional one-line description, then its content by group.
 * Blocks sit in one column and a hairline with section space rules them apart; the first block has neither. A form
 * lives inside its block and ends with its own Save button, with no footer band. The frame is the shell's `Section`.
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
    <Section role="block" title={title} description={description} action={action} id={id} testId={testId}>
      {children}
    </Section>
  );
}

/** A ruled list of items inside a block (mailboxes, documents, stages): hairlines between rows, no box around them. */
export const RULED_LIST = "divide-y";

/** One row of a ruled list. The first row starts at the heading's group gap and the last row ends flush. */
export const RULED_ROW = "py-3 first:pt-0 last:pb-0";
