"use client";

import { PencilIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useId, useState, useTransition, type FormEvent, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { toast } from "sonner";
import { DatePicker } from "@/components/shell/date-picker";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";

/** The label column every fact row shares, read-only or editable, so a panel lines up whatever it holds. */
const ROW = "grid grid-cols-[6.5rem_minmax(0,1fr)] items-baseline gap-3";

/** A read-only fact: a muted label and its value. */
export function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className={ROW}>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  );
}

export const NotSet = ({ children = "Not set" }: { children?: ReactNode }) => <span className="text-muted-foreground">{children}</span>;

export interface InlineInput {
  key: string;
  /** Shown above the input when the editor has more than one. A single input takes the row's label. */
  label?: string;
  value: string;
  /** "date" edits a yyyy-MM-dd day in a `DatePicker` with its calendar open; any other type is the Input's. */
  type?: string;
  inputMode?: "email" | "tel" | "url" | "numeric" | "decimal";
  placeholder?: string;
  help?: string;
}

/** What a save answers: null when it went through, else the message to show under the inputs. */
export type SaveResult = string | null;

export interface EditorProps {
  /** Ends the edit. `saved` refreshes the page first, so the row shows the stored value. */
  close: (saved: boolean) => void;
}

/**
 * One fact you edit where you read it. The pencil, a click on the value or Enter on the pencil opens the editor in the
 * row; Enter saves, Escape cancels, and a failed save keeps what you typed with the reason under it. Either `inputs` with
 * `onSave`, or `editor` for a row that needs its own form (the company row).
 */
export function EditableFact({
  label,
  children,
  inputs,
  onSave,
  editor,
  saved,
  testId,
}: {
  label: string;
  children: ReactNode;
  inputs?: InlineInput[];
  onSave?: (values: Record<string, string>) => Promise<SaveResult>;
  editor?: (props: EditorProps) => ReactNode;
  /** The toast after a save. */
  saved?: string;
  testId?: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [refreshing, startRefresh] = useTransition();
  // After an edit ends, focus goes back to the pencil that opened it.
  const [edited, setEdited] = useState(false);
  const pencil = useCallback((el: HTMLButtonElement | null) => {
    if (edited) el?.focus();
  }, [edited]);

  function close(didSave: boolean) {
    setEdited(true);
    if (!didSave) return setOpen(false);
    if (saved) toast.success(saved);
    // The row closes with the refreshed page, so the old value never flashes back.
    startRefresh(() => {
      router.refresh();
      setOpen(false);
    });
  }

  function openFromValue(event: MouseEvent<HTMLElement>) {
    // A link in the value keeps working; a click anywhere else on the value opens the editor.
    if ((event.target as HTMLElement).closest("a, button")) return;
    if (window.getSelection()?.toString()) return;
    setOpen(true);
  }

  if (open) {
    return (
      <div className="stack-field" data-testid={testId}>
        {editor ? editor({ close }) : <InlineEditor label={label} inputs={inputs ?? []} onSave={onSave!} close={close} busy={refreshing} />}
      </div>
    );
  }

  return (
    <div className={`group ${ROW} grid-cols-[6.5rem_minmax(0,1fr)_auto]`} data-testid={testId}>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 cursor-text break-words" onClick={openFromValue}>
        {children}
      </dd>
      <Button
        ref={pencil}
        type="button"
        variant="ghost"
        size="icon-xs"
        touch
        aria-label={`Edit ${label}`}
        // Quiet until the row is hovered or focused; always there on a touch screen, at a thumb's size.
        className="-my-1 self-center text-muted-foreground opacity-0 group-hover:opacity-100 focus-visible:opacity-100 max-sm:-my-3 [@media(hover:none)]:opacity-100"
        onClick={() => setOpen(true)}
      >
        <PencilIcon />
      </Button>
    </div>
  );
}

/** The inputs of one row, with Save and Cancel. */
function InlineEditor({ label, inputs, onSave, close, busy }: { label: string; inputs: InlineInput[]; onSave: (values: Record<string, string>) => Promise<SaveResult>; close: EditorProps["close"]; busy: boolean }) {
  const base = useId();
  const [values, setValues] = useState<Record<string, string>>(Object.fromEntries(inputs.map((i) => [i.key, i.value])));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const single = inputs.length === 1;
  const errorId = `${base}-error`;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (inputs.every((i) => (values[i.key] ?? "") === i.value)) return close(false);
    setPending(true);
    setError(null);
    const problem = await onSave(values);
    setPending(false);
    if (problem) return setError(problem);
    close(true);
  }

  return (
    <InlineForm label={single ? label : null} onSubmit={submit} onCancel={() => close(false)} busy={pending || busy} error={error} errorId={errorId}>
      {inputs.map((input, index) => {
        const id = `${base}-${input.key}`;
        return (
          <Field key={input.key}>
            <FieldLabel htmlFor={id} className={single ? "sr-only" : undefined}>
              {single ? label : input.label}
            </FieldLabel>
            {input.type === "date" ? (
              <DatePicker
                id={id}
                defaultOpen={index === 0}
                value={values[input.key] ?? ""}
                aria-invalid={error ? true : undefined}
                aria-describedby={[error ? errorId : null, input.help ? `${id}-help` : null].filter(Boolean).join(" ") || undefined}
                clearable
                className="w-40"
                onChange={(day) => setValues({ ...values, [input.key]: day })}
              />
            ) : (
              <Input
                id={id}
                autoFocus={index === 0}
                type={input.type ?? "text"}
                inputMode={input.inputMode}
                autoComplete="off"
                placeholder={input.placeholder}
                value={values[input.key] ?? ""}
                aria-invalid={error ? true : undefined}
                aria-describedby={[error ? errorId : null, input.help ? `${id}-help` : null].filter(Boolean).join(" ") || undefined}
                touch
                onChange={(e) => setValues({ ...values, [input.key]: e.target.value })}
              />
            )}
            {input.help && (
              <FieldDescription id={`${id}-help`} className="text-xs">
                {input.help}
              </FieldDescription>
            )}
          </Field>
        );
      })}
    </InlineForm>
  );
}

/**
 * The frame of an inline edit: the row's label, the fields, the error and Save and Cancel. Escape cancels from anywhere in
 * it. Custom editors (the company row) use it too, so every row saves the same way.
 */
export function InlineForm({
  label,
  onSubmit,
  onCancel,
  busy,
  error,
  errorId,
  submitLabel = "Save",
  extra,
  children,
}: {
  /** The row's label above the fields, or null when each field names itself. */
  label: string | null;
  onSubmit: (event: FormEvent) => void;
  onCancel: () => void;
  busy: boolean;
  error: string | null;
  errorId: string;
  submitLabel?: string;
  /** A further action beside Save and Cancel, such as Remove company. */
  extra?: ReactNode;
  children: ReactNode;
}) {
  function onKeyDown(event: KeyboardEvent<HTMLFormElement>) {
    // A picker's popup sits in a portal, and React still bubbles its keys here: its Escape closes only the popup.
    if (event.key !== "Escape" || !event.currentTarget.contains(event.target as Node)) return;
    event.preventDefault();
    event.stopPropagation();
    if (!busy) onCancel();
  }

  return (
    <form onSubmit={onSubmit} onKeyDown={onKeyDown} className="stack-field rounded-md bg-muted/40 p-2.5 -mx-2.5" noValidate>
      {label && <p className="text-sm text-muted-foreground" aria-hidden>{label}</p>}
      {children}
      {error && (
        <FieldError id={errorId}>{error}</FieldError>
      )}
      <div className="flex flex-wrap items-center gap-2 pt-1">
        <Button type="submit" size="sm" disabled={busy} touch>
          {busy ? "Saving…" : submitLabel}
        </Button>
        <Button type="button" size="sm" variant="ghost" disabled={busy} touch onClick={onCancel}>
          Cancel
        </Button>
        {extra}
      </div>
    </form>
  );
}
