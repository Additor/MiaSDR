"use client";

import { useRef, useState } from "react";
import { ConfirmDialog } from "@/components/shell/confirm-dialog";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { countOf } from "@/shared/format-number";
import { parseRowCount, planSubmit } from "../_lib/edit/add-rows";

interface Props {
  /** Adds the rows and returns an error message, or null when it worked. */
  onAdd: (count: number) => Promise<string | null>;
  onClose: () => void;
}

/** Blank rows in bulk, 1 to 1,000 at a time. The grid scrolls to the end once they exist. */
export function AddRowsDialog({ onAdd, onClose }: Props) {
  const [text, setText] = useState("100");
  const parsed = parseRowCount(text);

  // A ref, not the dialog's pending state: a second Enter in the same tick still sees the old render's state. It holds the
  // add in flight, so a second press waits on the same add instead of sending another.
  const inFlight = useRef<Promise<void> | null>(null);

  function submit(): Promise<void> {
    const plan = planSubmit(inFlight.current !== null, text);
    if (plan.kind === "skip" && inFlight.current) return inFlight.current;
    if (plan.kind !== "add") return Promise.reject(new Error(plan.kind === "error" ? plan.error : "Something went wrong."));
    const add = onAdd(plan.count)
      .then((problem) => {
        if (problem) throw new Error(problem);
      })
      .finally(() => {
        inFlight.current = null;
      });
    inFlight.current = add;
    return add;
  }

  return (
    <ConfirmDialog
      open
      onOpenChange={(open) => !open && onClose()}
      title="Add rows"
      description="Blank rows are added at the end of the table, up to 1,000 at a time."
      confirmLabel={parsed.ok ? `Add ${countOf(parsed.count, "row")}` : "Add rows"}
      pendingLabel="Adding…"
      confirmDisabled={!parsed.ok}
      onConfirm={submit}
    >
      <Field>
        <FieldLabel htmlFor="add-rows-count">Number of rows</FieldLabel>
        <Input id="add-rows-count" inputMode="numeric" value={text} onChange={(e) => setText(e.target.value)} autoFocus onFocus={(e) => e.currentTarget.select()} aria-invalid={!parsed.ok} />
        <FieldError>{parsed.ok ? null : parsed.error}</FieldError>
      </Field>
    </ConfirmDialog>
  );
}
