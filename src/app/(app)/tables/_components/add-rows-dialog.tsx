"use client";

import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { parseRowCount, planSubmit } from "../_lib/edit/add-rows";
import { ErrorText, Field } from "./form-bits";

interface Props {
  /** Adds the rows and returns an error message, or null when it worked. */
  onAdd: (count: number) => Promise<string | null>;
  onClose: () => void;
}

/** Blank rows in bulk, 1 to 1,000 at a time. The grid scrolls to the end once they exist. */
export function AddRowsDialog({ onAdd, onClose }: Props) {
  const [text, setText] = useState("100");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const parsed = parseRowCount(text);

  // A ref, not `busy`: a second Enter in the same tick still sees the old render's state.
  const inFlight = useRef(false);

  async function submit() {
    const plan = planSubmit(inFlight.current, text);
    if (plan.kind === "skip") return;
    if (plan.kind === "error") return setError(plan.error);
    inFlight.current = true;
    setBusy(true);
    setError(null);
    let problem: string | null;
    try {
      problem = await onAdd(plan.count);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
    if (problem) return setError(problem);
    onClose();
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add rows</DialogTitle>
          <DialogDescription>Blank rows are added at the end of the table, up to 1,000 at a time.</DialogDescription>
        </DialogHeader>
        <form onSubmit={(e) => (e.preventDefault(), void submit())} className="grid gap-3">
          <Field label="Number of rows" htmlFor="add-rows-count">
            <Input id="add-rows-count" inputMode="numeric" value={text} onChange={(e) => setText(e.target.value)} autoFocus onFocus={(e) => e.currentTarget.select()} aria-invalid={!parsed.ok} />
          </Field>
          <ErrorText>{error ?? (parsed.ok ? null : parsed.error)}</ErrorText>
        </form>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="button" onClick={() => void submit()} disabled={busy || !parsed.ok}>
            {busy ? "Adding..." : parsed.ok ? `Add ${parsed.count.toLocaleString("en-US")} ${parsed.count === 1 ? "row" : "rows"}` : "Add rows"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
