"use client";

import { CircleHelpIcon } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";

/** A send nobody can confirm: the person checks where the channel keeps its sent messages, then marks what they found. */
export function UncertainBox({ noteId, advice, busy, onResolve }: { noteId: string; advice: string; busy: boolean; onResolve: (outcome: "delivered" | "not_delivered", note: string) => void }) {
  const [note, setNote] = useState("");
  return (
    // An unconfirmed send is uncertain: the warning hue on the icon and the lead words only, no frame.
    <div className="grid gap-2 text-sm" data-testid="uncertain-box">
      <div className="flex items-start gap-2">
        <CircleHelpIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-warning" />
        <p>
          <strong className="font-medium text-warning">Not confirmed.</strong> {advice}
        </p>
      </div>
      <Field>
        <FieldLabel htmlFor={noteId}>How did you check?</FieldLabel>
        <Input id={noteId} value={note} onChange={(e) => setNote(e.target.value)} />
      </Field>
      <div className="flex gap-2">
        <Button size="sm" touch disabled={busy || !note.trim()} onClick={() => onResolve("delivered", note)}>
          Confirm delivered
        </Button>
        <Button size="sm" variant="outline" touch disabled={busy || !note.trim()} onClick={() => onResolve("not_delivered", note)}>
          Not delivered
        </Button>
      </div>
    </div>
  );
}
