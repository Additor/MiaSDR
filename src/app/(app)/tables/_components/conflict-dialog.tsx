"use client";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { ConflictItem } from "../_lib/edit/optimistic";
import type { GridColumn } from "../_lib/data/types";
import { displayValue } from "../_lib/view/format";

interface Props {
  items: ConflictItem[];
  columns: GridColumn[];
  rowNumbers: Map<string, number>;
  onResolve: (choice: "retry" | "discard") => void;
}

const show = (value: unknown, column: GridColumn | undefined) => {
  const text = column ? displayValue(value, column) : value === null || value === undefined ? "" : String(value);
  return text === "" ? "(empty)" : text;
};

/** Another person or a run changed rows you edited. Shows both values, then retries yours or keeps theirs. */
export function ConflictDialog({ items, columns, rowNumbers, onResolve }: Props) {
  const byKey = new Map(columns.map((c) => [c.key, c]));
  return (
    <Dialog open onOpenChange={(open) => !open && onResolve("discard")}>
      <DialogContent className="max-h-[92svh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Some rows changed while you edited</DialogTitle>
          <DialogDescription>Nothing was saved. The rows below now hold different values. Retry to write yours over them, or keep what is there.</DialogDescription>
        </DialogHeader>
        <ul className="grid gap-2">
          {items.map((item) => {
            const column = byKey.get(item.columnKey);
            return (
              <li key={`${item.rowId}:${item.columnKey}`} className="rounded-lg border p-2.5 text-sm">
                <p className="mb-1 text-xs text-muted-foreground">
                  Row {rowNumbers.get(item.rowId) ?? "?"} · {column?.name ?? item.columnKey}
                </p>
                {item.deleted ? (
                  <p>This row was deleted. Your edit is dropped.</p>
                ) : (
                  <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
                    <dt className="text-muted-foreground">Now</dt>
                    <dd className="break-words">{show(item.theirs, column)}</dd>
                    <dt className="text-muted-foreground">Yours</dt>
                    <dd className="break-words font-medium">{show(item.mine, column)}</dd>
                  </dl>
                )}
              </li>
            );
          })}
        </ul>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onResolve("discard")}>
            Keep current values
          </Button>
          <Button type="button" onClick={() => onResolve("retry")}>
            Retry my edits
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
