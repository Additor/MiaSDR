"use client";

import { useState } from "react";
import { MAX_NAME } from "@/components/shell/editable-title";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ErrorText, Field } from "./form-bits";

interface Props {
  title: string;
  description?: string;
  initial?: string;
  label?: string;
  submitLabel: string;
  /** Returns an error message, or null when it worked. */
  onSubmit: (name: string) => Promise<string | null>;
  onClose: () => void;
}

/** One text field in a dialog. The tables browser uses it to name and rename folders and workbooks. */
export function NameDialog({ title, description, initial = "", label = "Name", submitLabel, onSubmit, onClose }: Props) {
  const [name, setName] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    const problem = await onSubmit(name.trim());
    setBusy(false);
    if (problem) return setError(problem);
    onClose();
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        <form onSubmit={(e) => (e.preventDefault(), void submit())} className="grid gap-3">
          <Field label={label} htmlFor="name-dialog-input">
            <Input id="name-dialog-input" value={name} onChange={(e) => setName(e.target.value)} autoFocus maxLength={MAX_NAME} onFocus={(e) => e.currentTarget.select()} />
          </Field>
          <ErrorText>{error}</ErrorText>
        </form>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="button" onClick={() => void submit()} disabled={busy || !name.trim()}>
            {busy ? "Saving..." : submitLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
