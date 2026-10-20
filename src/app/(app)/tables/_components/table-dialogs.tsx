"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { gridRequest, gridUrl } from "../_lib/data/client";
import { Choice, ErrorText, Field } from "./form-bits";

const MAX_DESCRIPTION = 2_000;

/** Edits the note shown under the table tabs. An empty note clears it. */
export function DescriptionDialog({ tableName, initial, onSubmit, onClose }: { tableName: string; initial: string; onSubmit: (description: string) => Promise<string | null>; onClose: () => void }) {
  const [text, setText] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    const problem = await onSubmit(text.trim());
    setBusy(false);
    if (problem) return setError(problem);
    onClose();
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit description</DialogTitle>
          <DialogDescription>A note about &ldquo;{tableName}&rdquo;, shown under the table tabs.</DialogDescription>
        </DialogHeader>
        <Field label="Description" htmlFor="table-description">
          <Textarea id="table-description" value={text} onChange={(e) => setText(e.target.value)} rows={4} maxLength={MAX_DESCRIPTION} autoFocus />
        </Field>
        <ErrorText>{error}</ErrorText>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="button" onClick={() => void submit()} disabled={busy}>
            {busy ? "Saving..." : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface WorkbookOption {
  id: string;
  name: string;
  tableCount: number;
}

/** Picks another workbook to receive the table. The table joins the end of that workbook's tabs. */
export function MoveTableDialog({ tableName, currentWorkbookId, onSubmit, onClose }: { tableName: string; currentWorkbookId: string; onSubmit: (workbookId: string, workbookName: string) => Promise<string | null>; onClose: () => void }) {
  const [options, setOptions] = useState<WorkbookOption[] | null>(null);
  const [dest, setDest] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void gridRequest<{ workbooks: WorkbookOption[] }>(gridUrl.workbooks, "GET").then((res) => {
      if (cancelled) return;
      if (!res.ok || !res.data) return setError(res.error ?? "Could not load the workbooks. Close this dialog and try again.");
      const others = res.data.workbooks.filter((w) => w.id !== currentWorkbookId).sort((a, b) => a.name.localeCompare(b.name));
      setOptions(others);
      setDest(others[0]?.id ?? "");
    });
    return () => {
      cancelled = true;
    };
  }, [currentWorkbookId]);

  async function submit() {
    setBusy(true);
    setError(null);
    const problem = await onSubmit(dest, options?.find((w) => w.id === dest)?.name ?? "the workbook");
    setBusy(false);
    if (problem) return setError(problem);
    onClose();
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Move &ldquo;{tableName}&rdquo; to another workbook</DialogTitle>
          <DialogDescription>Its columns, rows and view move with it. Formulas that look the table up by name resolve in the new workbook.</DialogDescription>
        </DialogHeader>
        {options && options.length === 0 && <p className="text-sm text-muted-foreground">There is no other workbook yet. Create one first.</p>}
        {options && options.length > 0 && (
          <Field label="Destination workbook" htmlFor="move-table-dest">
            <Choice id="move-table-dest" label="Destination workbook" items={options.map((w) => ({ value: w.id, label: `${w.name} (${w.tableCount} ${w.tableCount === 1 ? "table" : "tables"})` }))} value={dest} onChange={setDest} />
          </Field>
        )}
        <ErrorText>{error}</ErrorText>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="button" onClick={() => void submit()} disabled={busy || !dest}>
            {busy ? "Moving..." : "Move table"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
