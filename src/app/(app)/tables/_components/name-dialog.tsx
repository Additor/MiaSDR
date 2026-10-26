"use client";

import { useState } from "react";
import { ConfirmDialog } from "@/components/shell/confirm-dialog";
import { MAX_NAME } from "@/components/shell/editable-title";
import { Input } from "@/components/ui/input";
import { Field } from "./form-bits";

interface Props {
  title: string;
  description: string;
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

  return (
    <ConfirmDialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={title}
      description={description}
      confirmLabel={submitLabel}
      pendingLabel="Saving…"
      confirmDisabled={!name.trim()}
      onConfirm={async () => {
        const problem = await onSubmit(name.trim());
        if (problem) throw new Error(problem);
      }}
    >
      <div>
        <Field label={label} htmlFor="name-dialog-input">
          <Input id="name-dialog-input" value={name} onChange={(e) => setName(e.target.value)} autoFocus maxLength={MAX_NAME} onFocus={(e) => e.currentTarget.select()} />
        </Field>
      </div>
    </ConfirmDialog>
  );
}
