"use client";

import { useRouter } from "next/navigation";
import { useId, useState } from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/shell/confirm-dialog";
import { EmptyState } from "@/components/shell/empty-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { orThrow, runApiAction } from "@/app/_lib/api-action";
import { callApi } from "@/app/_lib/api-client";
import { useApiAction } from "@/app/_lib/use-api-action";
import { BRAIN_FIELDS } from "@/contexts/brain/domain/brain-fields";
import { MAX_TITLE } from "@/contexts/brain/domain/brain-item";
import { BRAIN_KIND_LABELS } from "@/contexts/brain/domain/brain-kinds";
import type { SuggestionView } from "@/contexts/mia/application/mia-use-cases";
import { fieldsOf, formValuesOf, requiredFilled } from "../_lib/brain-form";
import { FieldInput } from "./brain-item-dialog";

function kindLine(view: SuggestionView): string {
  const kind = BRAIN_KIND_LABELS[view.kind];
  if (view.sorting) return `Sorts this document as ${kind}`;
  return view.type === "item_change" ? `Changes this ${kind}` : `New ${kind}`;
}

/** One suggestion to compare and save. Every field stays editable, and a value its sentence does not support needs a person's tick. */
function ReviewDialog({ view, open, onOpenChange }: { view: SuggestionView; open: boolean; onOpenChange: (open: boolean) => void }) {
  const router = useRouter();
  const id = useId();
  const needsTitle = BRAIN_FIELDS[view.kind].titleField === undefined;
  const start = () => formValuesOf(view.kind, view.fields);
  const [values, setValues] = useState(start);
  const [title, setTitle] = useState(view.title);
  const [confirmed, setConfirmed] = useState<string[]>([]);
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setValues(start());
      setTitle(view.title);
      setConfirmed([]);
    }
  }

  const original = start();
  const unchecked = view.rows.filter((row) => row.unverified && values[row.key] === original[row.key] && !confirmed.includes(row.key));

  async function save() {
    const body = { fields: fieldsOf(view.kind, values), confirmed, ...(needsTitle ? { title } : {}), ...(view.revision === null ? {} : { revision: view.revision }) };
    orThrow(await runApiAction(callApi(`/api/mia/suggestions/${view.id}/accept`, "POST", body), { refresh: () => router.refresh() }));
    toast.success(`${view.title} saved to Brain.`);
  }

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Review ${view.title}`}
      description={view.sorting ? "Check what Mia moved into each field. The old text stays as an earlier version." : "Check each value against the sentence it came from. Reply drafts may use what you save."}
      confirmLabel="Save to Brain"
      pendingLabel="Saving…"
      confirmDisabled={unchecked.length > 0 || !requiredFilled(view.kind, values) || (needsTitle && title.trim() === "")}
      className="sm:max-w-2xl"
      onConfirm={save}
    >
      <FieldGroup>
        {needsTitle && (
          <Field>
            <FieldLabel htmlFor={`${id}-title`}>Title</FieldLabel>
            <Input id={`${id}-title`} value={title} onChange={(e) => setTitle(e.target.value)} maxLength={MAX_TITLE} required />
          </Field>
        )}
        {view.rows.map((row) => {
          const inputId = `${id}-${row.key}`;
          return (
            <Field key={row.key} data-testid="mia-field">
              <FieldLabel htmlFor={inputId}>{row.label}</FieldLabel>
              <FieldInput field={row.field} id={inputId} value={values[row.key] ?? ""} onChange={(value) => setValues({ ...values, [row.key]: value })} />
              {view.type === "item_change" && !view.sorting && <FieldDescription>Now: {row.current || "empty"}</FieldDescription>}
              {row.quote && (
                <blockquote className="border-l-2 pl-2 text-xs whitespace-pre-wrap text-muted-foreground">
                  {row.quote}
                  {row.sourceUrl && (
                    <>
                      {" "}
                      <a href={row.sourceUrl} target="_blank" rel="noreferrer noopener" className="underline">
                        Source
                      </a>
                    </>
                  )}
                </blockquote>
              )}
              {row.unverified && values[row.key] === original[row.key] && (
                <div className="flex items-center gap-2 text-xs" data-testid="mia-unverified">
                  <Checkbox
                    id={`${inputId}-ok`}
                    checked={confirmed.includes(row.key)}
                    onCheckedChange={(checked) => setConfirmed(checked === true ? [...confirmed, row.key] : confirmed.filter((key) => key !== row.key))}
                  />
                  <label htmlFor={`${inputId}-ok`}>Not found in the source. I checked this value.</label>
                </div>
              )}
            </Field>
          );
        })}
      </FieldGroup>
    </ConfirmDialog>
  );
}

function SuggestionRow({ view }: { view: SuggestionView }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { isBusy, run } = useApiAction();
  const dismiss = () =>
    run(view.id, async () => {
      setError(null);
      const result = await runApiAction(callApi(`/api/mia/suggestions/${view.id}/dismiss`, "POST", {}), { refresh: () => router.refresh() });
      if (!result.ok) setError(result.error);
    });
  const gone = view.type === "item_change" && view.targetItemId === null;
  const toCheck = view.rows.filter((row) => row.unverified).length;
  return (
    <li className="flex flex-wrap items-center gap-3 border-b py-3" data-testid="mia-suggestion">
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{view.title}</p>
        <p className="text-xs text-muted-foreground">{gone ? "The item this changed is gone." : kindLine(view)}</p>
        {error && (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}
      </div>
      {toCheck > 0 && <Badge variant="secondary">{toCheck === 1 ? "1 value to check" : `${toCheck} values to check`}</Badge>}
      {!gone && (
        <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
          Review
        </Button>
      )}
      <Button size="sm" variant="ghost" disabled={isBusy(view.id)} onClick={() => void dismiss()}>
        Dismiss
      </Button>
      {!gone && <ReviewDialog view={view} open={open} onOpenChange={setOpen} />}
    </li>
  );
}

export function MiaSuggestions({ rows, total }: { rows: SuggestionView[]; total: number }) {
  if (rows.length === 0) return <EmptyState title="No suggestions" description="Use Fill with Mia to read your website or some text. What it finds waits here for your review." />;
  return (
    <>
      <ul className="border-t" aria-label="Suggestions">
        {rows.map((view) => (
          <SuggestionRow key={view.id} view={view} />
        ))}
      </ul>
      {total > rows.length && <p className="text-xs text-muted-foreground">Showing the newest {rows.length} of {total}. Decide these to see the rest.</p>}
    </>
  );
}
