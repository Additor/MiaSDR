"use client";

import { PlayIcon } from "lucide-react";
import { useId, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { DialogFooter } from "@/components/ui/dialog";
import { Field, FieldDescription, FieldGroup, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { MAX_DELAY_SECONDS, MAX_REUSE_DAYS } from "@/contexts/grid/enrichment/domain/enrichment-config";
import { acceptsText } from "@/contexts/grid/enrichment/domain/enrichment-inputs";
import { gridUrl } from "../_lib/data/client";
import type { CellRequest } from "../_lib/data/cell-request";
import type { ActionSpec } from "../_lib/data/providers";
import type { GridColumn } from "../_lib/data/types";
import { DEFAULT_FIRST_N, RUN_MAX_ROWS, runSummary, type RunEstimate } from "../_lib/data/run-request";
import { spendSummary } from "../_lib/data/waterfall-steps";
import { ColumnSelect } from "./form-bits";

/** What each form of the enrichment dialog takes. */
export interface EnrichmentFormProps {
  tableId: string;
  columns: GridColumn[];
  /** Set to edit the inputs and timing of an existing enrichment or waterfall column. */
  column: GridColumn | null;
  afterColumnId?: string;
  /** The action key of the outcome to open on, from the start strip. */
  outcome?: string;
  onClose: () => void;
  /** After a save; `addedKey` is the new column's key, so the grid can bring it into view. */
  onSaved: (addedKey?: string) => Promise<void>;
}

export function RunTiming({ autoRun, setAutoRun, delay, setDelay }: { autoRun: boolean; setAutoRun: (v: boolean) => void; delay: string; setDelay: (v: string) => void }) {
  return (
    <div className="grid gap-group sm:grid-cols-2">
      <CheckField checked={autoRun} onChange={setAutoRun}>
        Run automatically when its inputs change
      </CheckField>
      <NumberField id="run-delay" label="Delay before each call (seconds)" max={MAX_DELAY_SECONDS} value={delay} onChange={setDelay} />
    </div>
  );
}

/** A checkbox and its label as a horizontal field. */
export function CheckField({ checked, onChange, children, className }: { checked: boolean; onChange: (checked: boolean) => void; children: React.ReactNode; className?: string }) {
  const id = useId();
  return (
    <Field orientation="horizontal" className={className}>
      <Checkbox id={id} checked={checked} onCheckedChange={(v) => onChange(v === true)} />
      <FieldLabel htmlFor={id}>{children}</FieldLabel>
    </Field>
  );
}

/** A short number field with its label and an optional hint the input names as its description. */
export function NumberField({ id, label, hint, value, onChange, step, max }: { id: string; label: string; hint?: string; value: string; onChange: (value: string) => void; step?: number; max?: number }) {
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input id={id} type="number" min={0} max={max} step={step} value={value} onChange={(e) => onChange(e.target.value)} className="w-28" aria-describedby={hint ? `${id}-hint` : undefined} />
      {hint && <FieldDescription id={`${id}-hint`}>{hint}</FieldDescription>}
    </Field>
  );
}

export const WAIT_LABEL = "When a provider is busy, wait for it instead of trying the next one";
export const REUSE_LABEL = "Reuse a found answer for (days)";

/** The folded options of a new column, with their one-line summary. Caps apply to a column that tries several providers. */
export function SpendAndTiming(p: {
  waterfall: boolean;
  noPrice: boolean;
  maxCost: string;
  setMaxCost: (v: string) => void;
  maxCredits: string;
  setMaxCredits: (v: string) => void;
  waitOnLimit: boolean;
  setWaitOnLimit: (v: boolean) => void;
  autoRun: boolean;
  setAutoRun: (v: boolean) => void;
  delay: string;
  setDelay: (v: string) => void;
  reuseDays: string;
  setReuseDays: (v: string) => void;
}) {
  return (
    <details className="group rounded-lg border">
      <summary className="flex cursor-pointer list-none items-baseline justify-between gap-3 rounded-lg px-3 py-2 text-sm focus-ring">
        <span className="font-medium">Options</span>
        <span className="truncate text-xs text-muted-foreground">{spendSummary({ autoRun: p.autoRun, delay: p.delay, reuseDays: p.reuseDays, ...(p.waterfall ? { maxCost: p.maxCost, maxCredits: p.maxCredits, waitOnLimit: p.waitOnLimit } : {}) })}</span>
      </summary>
      <FieldGroup className="border-t px-3 py-3">
        {p.waterfall && (
          <div className="grid gap-group sm:grid-cols-2">
            <NumberField
              id="wf-cap"
              label="Spend cap per row ($)"
              hint={p.maxCost.trim() !== "" && p.noPrice ? "These providers have no price, so a dollar cap never stops a call. Use the credit cap." : "Optional. A provider that would pass it is skipped."}
              step={0.01}
              value={p.maxCost}
              onChange={p.setMaxCost}
            />
            <NumberField id="wf-credits" label="Credit cap per row" hint="Optional. Counts vendor credits, such as Hunter's half credit per verification." step={0.5} value={p.maxCredits} onChange={p.setMaxCredits} />
            <CheckField className="sm:col-span-2" checked={p.waitOnLimit} onChange={p.setWaitOnLimit}>
              {WAIT_LABEL}
            </CheckField>
          </div>
        )}
        <RunTiming autoRun={p.autoRun} setAutoRun={p.setAutoRun} delay={p.delay} setDelay={p.setDelay} />
        <NumberField id="reuse-days" label={REUSE_LABEL} hint="A provider answered the same lookup within this many days: the row takes that answer and you pay nothing. 0 always asks." max={MAX_REUSE_DAYS} value={p.reuseDays} onChange={p.setReuseDays} />
      </FieldGroup>
    </details>
  );
}

/** Why the add button is off, in one sentence, or null when the column can be added. */
export function blockerOf(state: { stepCount: number; noProvider: string; missingInput?: { name: string }; uncovered?: ActionSpec }): string | null {
  if (state.stepCount === 0) return state.noProvider;
  if (state.missingInput) return `Choose the column for ${state.missingInput.name}.`;
  if (state.uncovered) return `Map ${acceptsText(state.uncovered)}.`;
  return null;
}

/**
 * The fields an action returns besides its main answer, which the new column shows itself. Each ticked one becomes a
 * column of its own; the drawer of any cell can add the rest later.
 */
export function ExtraOutputs({ outputs, primary, chosen, onChange }: { outputs: ActionSpec["outputs"]; primary: string; chosen: string[]; onChange: (next: string[]) => void }) {
  const extra = outputs.filter((o) => o.key !== primary);
  if (extra.length === 0) return null;
  return (
    <FieldSet className="gap-field">
      <FieldLegend variant="label">Also add as columns</FieldLegend>
      <FieldDescription>The new column shows {outputs.find((o) => o.key === primary)?.name.toLowerCase() ?? "the main answer"}. Tick a field to give it a column too.</FieldDescription>
      <div className="grid gap-1 sm:grid-cols-2">
        {extra.map((o) => (
          <CheckField key={o.key} checked={chosen.includes(o.key)} onChange={(on) => onChange(on ? [...chosen, o.key] : chosen.filter((k) => k !== o.key))}>
            {o.name}
          </CheckField>
        ))}
      </div>
    </FieldSet>
  );
}

/**
 * The footer: the reason the add buttons are off or what a full run costs, Back, and two ways to add. "Add column" leads,
 * so nothing spends until you press Run; "Add and run first 10 rows" tries the column on a few rows at once.
 */
export function CreateFooter({ blocker, summary, busy, onBack, onSave, backLabel = "Back" }: { blocker: string | null; summary?: string | null; busy: boolean; onBack: () => void; onSave: (run: boolean) => void; backLabel?: string }) {
  const note = blocker ?? summary;
  // The button you pressed shows the progress.
  const [running, setRunning] = useState(false);
  const save = (run: boolean) => {
    setRunning(run);
    onSave(run);
  };
  return (
    <DialogFooter className="items-center">
      {note && (
        <p className="mr-auto text-sm text-muted-foreground tabular-nums" aria-live="polite">
          {note}
        </p>
      )}
      <Button type="button" variant="ghost" onClick={onBack} disabled={busy}>
        {backLabel}
      </Button>
      <Button type="button" variant="outline" onClick={() => save(true)} disabled={blocker !== null || busy}>
        <PlayIcon /> {busy && running ? "Adding…" : `Add and run first ${DEFAULT_FIRST_N} rows`}
      </Button>
      <Button type="button" onClick={() => save(false)} disabled={blocker !== null || busy}>
        {busy && !running ? "Adding…" : "Add column"}
      </Button>
    </DialogFooter>
  );
}

/**
 * Creates a runner column through `path` ("enrichments" or "ai"), then on `run` queues its first rows, both through
 * the open table's `cellRequest`. A refused run
 * leaves the column added and says why.
 */
export async function createColumn(cellRequest: CellRequest, tableId: string, body: Record<string, unknown>, run: boolean, path: "enrichments" | "ai" = "enrichments"): Promise<{ ok: true; key?: string } | { ok: false; error: string | null }> {
  const res = await cellRequest<{ primaryColumnKey?: string }>(gridUrl.sub(tableId, path), "POST", body);
  if (!res.ok) return { ok: false, error: res.error };
  const columnKey = res.data?.primaryColumnKey;
  if (run && columnKey) {
    const started = await cellRequest<RunEstimate & { queued: number }>(gridUrl.sub(tableId, "run"), "POST", { columnKey, firstN: DEFAULT_FIRST_N, onlyEmpty: true, maxRows: RUN_MAX_ROWS });
    if (started.ok && started.data) toast.success(runSummary(started.data));
    else toast.error(`The column was added, but the run did not start: ${started.error ?? "unknown error"}`);
  } else toast.success("Column added. Press Run when you are ready.");
  return { ok: true, key: columnKey };
}

/**
 * Inputs for the chosen actions: one column per input, guessed from the table, and the combinations still missing. A
 * mapped column shows its first value under it, so a wrong guess reads as wrong.
 */
export function InputFields({ specs, inputs, setInputs, columns, uncovered, missingInput, samples }: { specs: Array<{ key: string; name: string; required: boolean }>; inputs: Record<string, string>; setInputs: (next: Record<string, string>) => void; columns: GridColumn[]; uncovered?: ActionSpec; missingInput?: unknown; samples?: Record<string, string> }) {
  return (
    <FieldSet className="gap-2">
      <FieldLegend variant="label">Inputs</FieldLegend>
      {specs.map((input) => {
        const sample = inputs[input.key] ? samples?.[inputs[input.key]] : undefined;
        return (
          <Field key={input.key}>
            <FieldLabel htmlFor={`in-${input.key}`}>{`${input.name}${input.required ? " (required)" : ""}`}</FieldLabel>
            <ColumnSelect id={`in-${input.key}`} value={inputs[input.key] || null} none={input.required ? undefined : "Not used"} onChange={(v) => setInputs({ ...inputs, [input.key]: v ?? "" })} columns={columns} />
            {sample && <FieldDescription>First value: {sample}</FieldDescription>}
          </Field>
        );
      })}
      {!missingInput && uncovered && <p className="text-sm text-muted-foreground">Map {acceptsText(uncovered)}.</p>}
    </FieldSet>
  );
}
