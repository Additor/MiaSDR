"use client";

import type { ComponentProps, KeyboardEvent, ReactNode } from "react";
import { useSelection } from "@/components/shell/selection";
import { Checkbox } from "@/components/ui/checkbox";
import { TableRow } from "@/components/ui/table";
import { clearsSelectionOnKey } from "@/app/(app)/leads/_lib/bulk-actions";

/*
 * The selection pieces of the Contacts table. The page renders the table on the server and these read and write the
 * shared selection (`SelectionProvider`), so a tick survives paging and sort and resets on a filter change.
 */

/** The header checkbox: ticks or clears every contact on this page. */
export function PageCheckbox({ ids }: { ids: string[] }) {
  const { isSelected, select } = useSelection();
  const all = ids.length > 0 && ids.every(isSelected);
  const some = ids.some(isSelected);
  return <Checkbox checked={all} indeterminate={!all && some} onCheckedChange={(checked) => select(ids, Boolean(checked))} aria-label="Select all contacts on this page" />;
}

export function RowCheckbox({ id, label }: { id: string; label: string }) {
  const { isSelected, select } = useSelection();
  return <Checkbox checked={isSelected(id)} onCheckedChange={(checked) => select([id], Boolean(checked))} aria-label={`Select ${label}`} />;
}

/** A table row that marks itself selected while its contact is ticked. */
export function SelectableRow({ id, ...props }: ComponentProps<typeof TableRow> & { id: string }) {
  const { isSelected } = useSelection();
  return <TableRow {...props} data-state={isSelected(id) ? "selected" : undefined} />;
}

/** Esc inside the table clears the selection, so a keyboard user does not have to tab to Clear selection. */
export function SelectionKeys({ children }: { children: ReactNode }) {
  const { selectedIds, clear } = useSelection();
  function onKeyDown(event: KeyboardEvent) {
    if (clearsSelectionOnKey({ key: event.key, selectedCount: selectedIds.length, defaultPrevented: event.defaultPrevented })) clear();
  }
  return (
    <div className="min-w-0" onKeyDown={onKeyDown}>
      {children}
    </div>
  );
}
