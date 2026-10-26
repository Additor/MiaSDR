"use client";

import { ListFilterIcon } from "lucide-react";
import { useRef, type ReactNode } from "react";
import { emptyDraft, restoreDraft, type DraftControl } from "./filter-draft";
import { ToolbarPopover, ToolbarPopoverBody, ToolbarPopoverFooter } from "./toolbar-popover";

const controlsIn = (root: HTMLElement | null): DraftControl[] => (root ? Array.from(root.querySelectorAll<HTMLInputElement | HTMLSelectElement>("input, select")) : []);

/**
 * A list's Filters: a `ToolbarPopover` of GET form fields. Apply submits the form, so the filters live in the URL.
 * Without `form` the fields join the form around the toolbar, which keeps them while the popover is closed, so Enter in
 * the search sends the filters in force. With `form` the popover holds a form of its own.
 */
export function FilterPopover({ count, form, children }: { count: number; form?: { action: string; label: string; hidden?: ReactNode }; children: ReactNode }) {
  const body = useRef<HTMLDivElement>(null);
  const inner = (
    <>
      <ToolbarPopoverBody ref={body}>{children}</ToolbarPopoverBody>
      <ToolbarPopoverFooter onReset={() => emptyDraft(controlsIn(body.current))} />
    </>
  );
  return (
    <ToolbarPopover icon={ListFilterIcon} label="Filters" count={count} inline onDiscard={() => restoreDraft(controlsIn(body.current))} testId="filters-toggle">
      {form ? (
        <form action={form.action} method="get" aria-label={form.label} className="flex min-h-0 flex-1 flex-col">
          {form.hidden}
          {inner}
        </form>
      ) : (
        inner
      )}
    </ToolbarPopover>
  );
}
