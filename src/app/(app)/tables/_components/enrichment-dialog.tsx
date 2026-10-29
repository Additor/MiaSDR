"use client";

import { ArrowDownIcon, ArrowUpIcon, PlayIcon } from "lucide-react";
import { useId, useMemo, useState } from "react";
import { toast } from "sonner";
import { CHOICE_TILE } from "@/components/shell/choice-card";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { gridUrl } from "../_lib/data/client";
import { useCellRequest, type CellRequest } from "../_lib/data/cell-request";
import { DEFAULT_REUSE_DAYS, MAX_DELAY_SECONDS, MAX_REUSE_DAYS } from "@/contexts/grid/enrichment/domain/enrichment-config";
import { contractAction, SETTLED_STATUSES } from "@/contexts/grid/enrichment/domain/enrichment-contracts";
import { acceptsText, inputsCovered } from "@/contexts/grid/enrichment/domain/enrichment-inputs";
import { OUTCOMES, outcomeOf } from "../_lib/data/outcomes";
import { coverageText, fullRunText, useEnrichmentPreview } from "../_lib/data/enrichment-preview";
import { guessColumn, lookupCents, lookupPrice, usableProviders, useProviders, type ActionSpec, type CatalogEntry, type ProviderView } from "../_lib/data/providers";
import type { GridColumn } from "../_lib/data/types";
import { centsToDollarsText, creditCap, DEFAULT_FIRST_N, dollarsToCents, RUN_MAX_ROWS, runSummary, toRunSettingsBody, type RunEstimate } from "../_lib/data/run-request";
import { spendSummary, type WaterfallStep } from "../_lib/data/waterfall-steps";
import { ColumnSelect, ItemSelect } from "./form-bits";
import { ColumnChips, ConnectProviders, SetupRow } from "./enrichment-setup";
import { ProviderManager } from "./provider-manager";

interface Props {
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

type Step = WaterfallStep;

/** Adds an enrichment column from an outcome (one provider, or several tried in order as a waterfall), or edits one. */
export function EnrichmentDialog(props: Props) {
  return (
    <Dialog open onOpenChange={(open) => !open && props.onClose()}>
      <DialogContent className="max-h-[92svh] overflow-y-auto sm:max-w-2xl">
        {props.column ? <EditBody {...props} column={props.column} /> : <CreateBody {...props} />}
      </DialogContent>
    </Dialog>
  );
}

/** "companyDomain" to "Company domain", for an input whose action is not available (its provider is gone). */
const inputLabel = (key: string) => key.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase()).replace(/ ([A-Z])/g, (_, c: string) => ` ${c.toLowerCase()}`);

function EditBody({ tableId, columns, column, onClose, onSaved }: Props & { column: GridColumn }) {
  const cellRequest = useCellRequest();
  const { providers, catalog } = useProviders();
  const config = column.config as {
    inputs?: Record<string, string>;
    providerKey?: string;
    actionKey?: string;
    steps?: Step[];
    delaySeconds?: number;
    reuseDays?: number;
    settledStatuses?: string[];
    maxCostCents?: number;
    maxCredits?: number;
    onRateLimit?: "next" | "wait";
  };
  const isWaterfall = column.type === "waterfall";
  const steps: Step[] = isWaterfall ? (config.steps ?? []) : config.providerKey && config.actionKey ? [{ providerKey: config.providerKey, actionKey: config.actionKey }] : [];
  const actionKey = steps[0]?.actionKey;
  const initial = {
    inputs: config.inputs ?? {},
    autoRun: column.autoRun,
    delay: String(config.delaySeconds ?? 0),
    reuseDays: String(config.reuseDays ?? DEFAULT_REUSE_DAYS),
    stopAtCatchAll: config.settledStatuses?.includes("catch_all") ?? false,
    maxCost: config.maxCostCents === undefined ? "" : centsToDollarsText(config.maxCostCents),
    maxCredits: config.maxCredits === undefined ? "" : String(config.maxCredits),
    waitOnLimit: config.onRateLimit === "wait",
  };
  const [form, setForm] = useState(initial);
  const set = <K extends keyof typeof initial>(key: K, value: (typeof initial)[K]) => setForm((f) => ({ ...f, [key]: value }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sources = columns.filter((c) => c.id !== column.id);

  // The inputs of every step's action, with names and whether they are required. Without the action (its provider is
  // gone), the mapped keys still show, so the column stays editable.
  const usable = useMemo(() => usableProviders(providers, catalog), [providers, catalog]);
  const specs = useMemo(() => {
    const map = new Map<string, { key: string; name: string; required: boolean }>();
    for (const step of steps) {
      const action = usable.find((p) => p.key === step.providerKey)?.actions.find((a) => a.key === step.actionKey) ?? providers.find((p) => p.key === step.providerKey)?.actions.find((a) => a.key === step.actionKey);
      for (const i of action?.inputs ?? []) map.set(i.key, { key: i.key, name: i.name, required: (map.get(i.key)?.required ?? false) || i.required });
    }
    for (const key of Object.keys(initial.inputs)) if (!map.has(key)) map.set(key, { key, name: inputLabel(key), required: false });
    return [...map.values()];
    // Steps come from the saved column and do not change while the dialog is open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [usable, providers]);

  async function save() {
    const patch: Record<string, unknown> = { columnId: column.id };
    const inputs = Object.fromEntries(Object.entries(form.inputs).filter(([, v]) => v));
    if (JSON.stringify(inputs) !== JSON.stringify(initial.inputs)) patch.inputs = inputs;
    if (form.autoRun !== initial.autoRun) patch.autoRun = form.autoRun;
    const pacing = toRunSettingsBody(form);
    if (form.delay !== initial.delay) patch.delaySeconds = pacing.delaySeconds;
    if (form.reuseDays !== initial.reuseDays) patch.reuseDays = pacing.reuseDays;
    if (form.stopAtCatchAll !== initial.stopAtCatchAll) patch.settledStatuses = form.stopAtCatchAll ? [...SETTLED_STATUSES, "catch_all"] : null;
    if (isWaterfall) {
      if (form.maxCost !== initial.maxCost) {
        if (form.maxCost.trim() !== "" && dollarsToCents(form.maxCost) === null) return setError("Enter the spend cap as zero or more dollars, or leave it empty.");
        patch.maxCostCents = form.maxCost.trim() === "" ? null : dollarsToCents(form.maxCost);
      }
      if (form.maxCredits !== initial.maxCredits) patch.maxCredits = creditCap(form.maxCredits);
      if (form.waitOnLimit !== initial.waitOnLimit) patch.onRateLimit = form.waitOnLimit ? "wait" : "next";
    }
    if (Object.keys(patch).length === 1) return onClose();
    setBusy(true);
    setError(null);
    const res = await cellRequest(gridUrl.sub(tableId, "enrichments"), "PATCH", patch);
    if (!res.ok) {
      setBusy(false);
      return setError(res.error);
    }
    await onSaved();
    onClose();
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>Edit {column.name}</DialogTitle>
        <DialogDescription>Change which columns feed the provider, what a cell may spend and when it runs. Existing results stay until you run the column again.</DialogDescription>
      </DialogHeader>
      <FieldGroup>
        <FieldSet className="gap-2">
          <FieldLegend variant="label">Inputs</FieldLegend>
          {specs.map((input) => (
            <Field key={input.key}>
              <FieldLabel htmlFor={`edit-in-${input.key}`}>{`${input.name}${input.required ? " (required)" : ""}`}</FieldLabel>
              <ColumnSelect id={`edit-in-${input.key}`} value={form.inputs[input.key] || null} none={input.required ? undefined : "Not used"} onChange={(v) => set("inputs", { ...form.inputs, [input.key]: v ?? "" })} columns={sources} />
            </Field>
          ))}
        </FieldSet>
        {actionKey === "verify-email" && (
          <CheckField checked={form.stopAtCatchAll} onChange={(v) => set("stopAtCatchAll", v)}>
            {isWaterfall ? "Stop at a catch-all verdict instead of asking the next verifier" : "Count a catch-all verdict as found"}
          </CheckField>
        )}
        {isWaterfall && (
          <div className="grid gap-group sm:grid-cols-2">
            <NumberField id="edit-cap" label="Spend cap per row ($)" hint="Optional. A provider that would pass it is skipped. Leave empty for no cap." step={0.01} value={form.maxCost} onChange={(v) => set("maxCost", v)} />
            <NumberField id="edit-credits" label="Credit cap per row" hint="Optional. Counts vendor credits. Leave empty for no cap." step={0.5} value={form.maxCredits} onChange={(v) => set("maxCredits", v)} />
            <CheckField className="sm:col-span-2" checked={form.waitOnLimit} onChange={(v) => set("waitOnLimit", v)}>
              {WAIT_LABEL}
            </CheckField>
          </div>
        )}
        <NumberField id="edit-reuse" label={REUSE_LABEL} hint="0 always asks the provider." max={MAX_REUSE_DAYS} value={form.reuseDays} onChange={(v) => set("reuseDays", v)} />
        <RunTiming autoRun={form.autoRun} setAutoRun={(v) => set("autoRun", v)} delay={form.delay} setDelay={(v) => set("delay", v)} />
        <FieldError>{error}</FieldError>
      </FieldGroup>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button type="button" onClick={save} disabled={busy}>
          {busy ? "Saving…" : "Save"}
        </Button>
      </DialogFooter>
    </>
  );
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
function CheckField({ checked, onChange, children, className }: { checked: boolean; onChange: (checked: boolean) => void; children: React.ReactNode; className?: string }) {
  const id = useId();
  return (
    <Field orientation="horizontal" className={className}>
      <Checkbox id={id} checked={checked} onCheckedChange={(v) => onChange(v === true)} />
      <FieldLabel htmlFor={id}>{children}</FieldLabel>
    </Field>
  );
}

/** A short number field with its label and an optional hint the input names as its description. */
function NumberField({ id, label, hint, value, onChange, step, max }: { id: string; label: string; hint?: string; value: string; onChange: (value: string) => void; step?: number; max?: number }) {
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input id={id} type="number" min={0} max={max} step={step} value={value} onChange={(e) => onChange(e.target.value)} className="w-28" aria-describedby={hint ? `${id}-hint` : undefined} />
      {hint && <FieldDescription id={`${id}-hint`}>{hint}</FieldDescription>}
    </Field>
  );
}

const WAIT_LABEL = "When a provider is busy, wait for it instead of trying the next one";
const REUSE_LABEL = "Reuse a found answer for (days)";

type CreateView = { kind: "outcomes" } | { kind: "outcome"; actionKey: string } | { kind: "other" } | { kind: "connect"; back: CreateView };

/**
 * Adding an enrichment starts from what the column should hold: one of the four shared outcomes, or another action a
 * provider offers. Vendors are a choice inside the outcome, and ticking a second one makes the column a waterfall.
 * Connecting a provider is its own view, so the list of vendors never sits in the way of the form.
 */
function CreateBody(props: Props) {
  const providerState = useProviders();
  const { catalog, providers, loading, error: loadError, refresh } = providerState;
  const usable = useMemo(() => usableProviders(providers, catalog), [providers, catalog]);
  const [view, setView] = useState<CreateView>(() => (outcomeOf(props.outcome) ? { kind: "outcome", actionKey: props.outcome! } : { kind: "outcomes" }));
  const connect = () => setView({ kind: "connect", back: view });

  if (view.kind === "connect") {
    return (
      <>
        <DialogHeader>
          <DialogTitle>Connect providers</DialogTitle>
          <DialogDescription>Each provider uses your own account and key. MiaSDR checks a key with the vendor before it saves it, and never shows it again.</DialogDescription>
        </DialogHeader>
        <FieldError>{loadError}</FieldError>
        <ProviderManager catalog={catalog} providers={providers} onChanged={refresh} />
        <DialogFooter>
          <Button type="button" onClick={() => setView(view.back)}>
            Done
          </Button>
        </DialogFooter>
      </>
    );
  }
  if (loading) {
    return (
      <>
        <DialogHeader>
          <DialogTitle>Add enrichment</DialogTitle>
          <DialogDescription>Loading providers…</DialogDescription>
        </DialogHeader>
      </>
    );
  }
  if (view.kind === "outcome") {
    // Opened on one outcome from the Enrich menu, the dialog has nothing to go back to.
    const direct = props.outcome === view.actionKey;
    return (
      <OutcomeForm
        key={view.actionKey}
        {...props}
        actionKey={view.actionKey}
        usable={usable}
        providers={providers}
        catalog={catalog}
        loadError={loadError}
        refresh={refresh}
        onBack={direct ? props.onClose : () => setView({ kind: "outcomes" })}
        backLabel={direct ? "Cancel" : "Back"}
      />
    );
  }
  if (view.kind === "other") return <OtherActionForm {...props} usable={usable} onBack={() => setView({ kind: "outcomes" })} onConnect={connect} />;

  const shared = new Set<string>(OUTCOMES.map((o) => o.actionKey));
  const hasOther = usable.some((p) => p.actions.some((a) => !shared.has(a.key)));
  return (
    <>
      <DialogHeader>
        <DialogTitle>Add enrichment</DialogTitle>
        <DialogDescription>What should the new column hold? Nothing runs until you press Run, and every call uses your own provider account.</DialogDescription>
      </DialogHeader>
      <FieldError>{loadError}</FieldError>
      <ul className="grid gap-2 sm:grid-cols-2">
        {OUTCOMES.map((o) => {
          const ready = usable.filter((p) => p.actions.some((a) => a.key === o.actionKey));
          return (
            <li key={o.actionKey}>
              <button
                type="button"
                onClick={() => setView({ kind: "outcome", actionKey: o.actionKey })}
                className={CHOICE_TILE}
              >
                <span className="heading-item">{o.label}</span>
                <span className="text-xs text-muted-foreground">{o.fills}</span>
                <span className="text-xs">{ready.length > 0 ? `Ready: ${ready.map((p) => p.name).join(", ")}` : "No provider connected yet"}</span>
              </button>
            </li>
          );
        })}
      </ul>
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        {hasOther && (
          <Button type="button" variant="link" size="sm" className="h-auto p-0" onClick={() => setView({ kind: "other" })}>
            Other actions
          </Button>
        )}
        <Button type="button" variant="link" size="sm" className="h-auto p-0" onClick={connect}>
          {usable.length === 0 ? "Connect a provider" : "Connect or manage providers"}
        </Button>
      </div>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={props.onClose}>
          Cancel
        </Button>
      </DialogFooter>
    </>
  );
}

/** The folded options of a new column, with their one-line summary. Caps apply to a column that tries several providers. */
function SpendAndTiming(p: {
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
function blockerOf(state: { stepCount: number; noProvider: string; missingInput?: { name: string }; uncovered?: ActionSpec }): string | null {
  if (state.stepCount === 0) return state.noProvider;
  if (state.missingInput) return `Choose the column for ${state.missingInput.name}.`;
  if (state.uncovered) return `Map ${acceptsText(state.uncovered)}.`;
  return null;
}

/**
 * The fields an action returns besides its main answer, which the new column shows itself. Each ticked one becomes a
 * column of its own; the drawer of any cell can add the rest later.
 */
function ExtraOutputs({ outputs, primary, chosen, onChange }: { outputs: ActionSpec["outputs"]; primary: string; chosen: string[]; onChange: (next: string[]) => void }) {
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
function InputFields({ specs, inputs, setInputs, columns, uncovered, missingInput, samples }: { specs: Array<{ key: string; name: string; required: boolean }>; inputs: Record<string, string>; setInputs: (next: Record<string, string>) => void; columns: GridColumn[]; uncovered?: ActionSpec; missingInput?: unknown; samples?: Record<string, string> }) {
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

/** "A, B and C". */
const listText = (items: string[]) => (items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`);

/**
 * One outcome as three lines that read as a sentence: which provider, what each row matches on, and the columns it adds.
 * Each line opens its fields with Change. Until a connected provider offers the outcome, the dialog shows only the
 * vendors that do, and the form keeps what you set while you connect one.
 */
function OutcomeForm({ tableId, columns, afterColumnId, onClose, onSaved, actionKey, usable, providers, catalog, loadError, refresh, onBack, backLabel }: Props & { actionKey: string; usable: ProviderView[]; providers: ProviderView[]; catalog: CatalogEntry[]; loadError: string | null; refresh: () => Promise<void>; onBack: () => void; backLabel: string }) {
  const cellRequest = useCellRequest();
  const outcome = outcomeOf(actionKey)!;
  const offering = usable.filter((p) => p.actions.some((a) => a.key === actionKey));
  const actionOf = (key: string) => offering.find((p) => p.key === key)?.actions.find((a) => a.key === actionKey);
  // Every vendor that offers this outcome, connected or not.
  const vendors = catalog.filter((e) => e.status === "available" && e.adapter !== "http" && e.adapter !== "fake" && e.actions.some((a) => a.key === actionKey));
  // The shared contract fixes the inputs and the outputs every vendor of the outcome fills.
  const contract = contractAction(outcome.actionKey);

  // Null until you tick or reorder: the first provider that offers the outcome, once one is connected.
  const [pickedState, setPicked] = useState<string[] | null>(null);
  const picked = (pickedState ?? offering.slice(0, 1).map((p) => p.key)).filter((k) => offering.some((p) => p.key === k));
  const [inputs, setInputs] = useState<Record<string, string>>(() => Object.fromEntries(contract.inputs.map((i) => [i.key, guessColumn(i, columns) ?? ""])));
  const [outputs, setOutputs] = useState<string[]>(() => [...outcome.outputs]);
  const [name, setName] = useState("");
  const [stopAtCatchAll, setStopAtCatchAll] = useState(false);
  const [maxCost, setMaxCost] = useState("");
  const [maxCredits, setMaxCredits] = useState("");
  const [waitOnLimit, setWaitOnLimit] = useState(false);
  const [reuseDays, setReuseDays] = useState(String(DEFAULT_REUSE_DAYS));
  const [autoRun, setAutoRun] = useState(false);
  const [delay, setDelay] = useState("0");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<"provider" | "inputs" | "outputs" | null>(null);
  const [connecting, setConnecting] = useState(false);
  const toggleOpen = (row: "provider" | "inputs" | "outputs") => setOpen((o) => (o === row ? null : row));

  const chosen = picked.map(actionOf).filter((a): a is ActionSpec => !!a);
  const waterfall = picked.length >= 2;
  const inputSpecs = contract.inputs;
  // Every step runs the same action, but a vendor may add outputs of its own: one vendor's show, a waterfall shares only
  // the outputs every step fills.
  const outputSpecs = chosen.length === 0 ? contract.outputs : chosen[0].outputs.filter((o) => chosen.every((a) => a.outputs.some((x) => x.key === o.key)));
  const missingInput = inputSpecs.find((i) => i.required && !inputs[i.key]);
  const uncovered = !inputsCovered(contract, (key) => !!inputs[key]) ? contract : undefined;
  const capInvalid = waterfall && maxCost.trim() !== "" && dollarsToCents(maxCost) === null;
  const blocker =
    blockerOf({
      stepCount: picked.length,
      noProvider: offering.length === 0 ? `Connect a provider that can ${outcome.label.toLowerCase()}.` : "Tick a provider.",
      missingInput,
      uncovered,
    }) ?? (capInvalid ? "Enter the spend cap as zero or more dollars, or leave it empty." : null);
  const preview = useEnrichmentPreview(tableId, picked.map((providerKey) => ({ providerKey, actionKey })), inputs);

  const toggle = (key: string, on: boolean) => setPicked(on ? [...picked, key] : picked.filter((k) => k !== key));
  const move = (i: number, d: -1 | 1) => {
    const j = i + d;
    if (j < 0 || j >= picked.length) return;
    const next = picked.slice();
    [next[i], next[j]] = [next[j], next[i]];
    setPicked(next);
  };
  const ordered = [...picked.map((k) => offering.find((p) => p.key === k)!).filter(Boolean), ...offering.filter((p) => !picked.includes(p.key))];

  const columnName = name.trim() || outcome.column;
  const extraNames = outputSpecs.filter((o) => o.key !== contract.primaryOutput && outputs.includes(o.key)).map((o) => o.name);
  const mapped = inputSpecs.filter((i) => inputs[i.key]);
  const columnNameOf = (key: string) => columns.find((c) => c.key === key)?.name ?? key;
  const pickedNames = chosen.length > 0 ? picked.map((k) => offering.find((p) => p.key === k)?.name ?? k) : [];

  async function save(run: boolean) {
    setBusy(true);
    setError(null);
    const base = {
      inputs: Object.fromEntries(Object.entries(inputs).filter(([, v]) => v)),
      selectedOutputs: outputs.filter((k) => outputSpecs.some((o) => o.key === k)),
      afterColumnId: afterColumnId ?? columns[columns.length - 1]?.id,
      autoRun,
      ...toRunSettingsBody({ delay, reuseDays }),
    };
    const steps = picked.map((providerKey) => ({ providerKey, actionKey }));
    const body = waterfall
      ? {
          kind: "waterfall",
          name: columnName,
          steps,
          ...base,
          ...(stopAtCatchAll && actionKey === "verify-email" ? { settledStatuses: [...SETTLED_STATUSES, "catch_all"] } : {}),
          ...(maxCost.trim() !== "" && dollarsToCents(maxCost) !== null ? { maxCostCents: dollarsToCents(maxCost) } : {}),
          ...(creditCap(maxCredits) !== null ? { maxCredits: creditCap(maxCredits) } : {}),
          ...(waitOnLimit ? { onRateLimit: "wait" } : {}),
        }
      : { kind: "enrichment", name: columnName, providerKey: picked[0], actionKey, ...base };
    const res = await createColumn(cellRequest, tableId, body, run);
    if (!res.ok) {
      setBusy(false);
      return setError(res.error);
    }
    await onSaved(res.key);
    onClose();
  }

  const header = (
    <DialogHeader>
      <DialogTitle>{outcome.label}</DialogTitle>
      <DialogDescription>
        Adds {listText([columnName, ...extraNames])} for each row. Nothing runs until you press Run.
      </DialogDescription>
    </DialogHeader>
  );

  if (offering.length === 0 || connecting) {
    return (
      <>
        {header}
        <FieldError>{loadError}</FieldError>
        <ConnectProviders
          entries={vendors}
          providers={providers}
          onChanged={refresh}
          lead={offering.length === 0 ? `Connect a provider that can ${outcome.label.toLowerCase()}. What you set here waits until you do.` : `Providers that can ${outcome.label.toLowerCase()}.`}
        />
        <DialogFooter>
          {offering.length === 0 ? (
            <Button type="button" variant="ghost" onClick={onBack}>
              {backLabel}
            </Button>
          ) : (
            <Button type="button" onClick={() => setConnecting(false)}>
              Done
            </Button>
          )}
        </DialogFooter>
      </>
    );
  }

  return (
    <>
      {header}
      <div className="grid gap-4">
        <ul className="grid divide-y rounded-lg border">
          <SetupRow
            label="Provider"
            noun="providers"
            open={open === "provider"}
            onToggle={() => toggleOpen("provider")}
            summary={pickedNames.length === 0 ? "None ticked" : pickedNames.length === 1 ? <span className="font-medium">{pickedNames[0]}</span> : <span className="font-medium">{pickedNames.join(", then ")}</span>}
            detail={pickedNames.length === 1 ? lookupPrice(offering.find((p) => p.key === picked[0])!.defaultCostCents, chosen[0]) : pickedNames.length > 1 ? "Tried in order. The first that finds an answer fills the row, and the rest are not asked." : undefined}
          >
            <p className="text-xs text-muted-foreground">{offering.length > 1 ? "Tick another provider to try it when the first finds nothing." : "Connect a second provider to try it when this one finds nothing."}</p>
            <ul className="grid divide-y rounded-lg border">
              {ordered.map((p) => {
                const index = picked.indexOf(p.key);
                return (
                  <li key={p.key} className="flex items-center gap-2 px-3 py-1.5">
                    <label className="flex min-w-0 flex-1 items-center gap-2 text-sm">
                      <Checkbox checked={index >= 0} onCheckedChange={(v) => toggle(p.key, v === true)} />
                      {waterfall && index >= 0 && <span className="w-4 text-xs text-muted-foreground tabular-nums">{index + 1}</span>}
                      <span className="truncate font-medium">{p.name}</span>
                      <span className="text-xs text-muted-foreground">{lookupPrice(p.defaultCostCents, actionOf(p.key))}</span>
                    </label>
                    {waterfall && index >= 0 && (
                      <span className="flex">
                        <Button type="button" size="icon-sm" variant="ghost" aria-label={`Move ${p.name} up`} disabled={index === 0} onClick={() => move(index, -1)}>
                          <ArrowUpIcon />
                        </Button>
                        <Button type="button" size="icon-sm" variant="ghost" aria-label={`Move ${p.name} down`} disabled={index === picked.length - 1} onClick={() => move(index, 1)}>
                          <ArrowDownIcon />
                        </Button>
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
            {waterfall && actionKey === "verify-email" && (
              <CheckField checked={stopAtCatchAll} onChange={setStopAtCatchAll}>
                Stop at a catch-all verdict instead of asking the next verifier
              </CheckField>
            )}
            <Button type="button" variant="link" size="sm" className="h-auto w-fit p-0" onClick={() => setConnecting(true)}>
              Connect or manage providers
            </Button>
          </SetupRow>
          <SetupRow
            label="Match rows on"
            noun="inputs"
            // A mapping that covers nothing cannot be summed up, so its fields stay open until it does.
            open={open === "inputs" || !!uncovered || !!missingInput}
            onToggle={uncovered || missingInput ? undefined : () => toggleOpen("inputs")}
            summary={mapped.length === 0 ? "Nothing mapped yet" : <span className="font-medium">{mapped.map((i) => i.name).join(" + ")}</span>}
            detail={mapped.length === 0 ? undefined : `From ${listText(mapped.map((i) => columnNameOf(inputs[i.key])))}${preview && !uncovered ? ` · ${coverageText(preview)}` : ""}`}
          >
            <InputFields specs={inputSpecs} inputs={inputs} setInputs={setInputs} columns={columns} uncovered={uncovered} missingInput={missingInput} samples={preview?.samples} />
          </SetupRow>
          <SetupRow label="Adds" noun="columns" action="Edit" open={open === "outputs"} onToggle={() => toggleOpen("outputs")} summary={<ColumnChips names={[columnName, ...extraNames]} />}>
            <Field>
              <FieldLabel htmlFor="wf-name">Column name</FieldLabel>
              <Input id="wf-name" value={name} onChange={(e) => setName(e.target.value)} placeholder={outcome.column} aria-describedby="wf-name-hint" />
              <FieldDescription id="wf-name-hint">The column shows the main answer. Ticked fields get columns of their own.</FieldDescription>
            </Field>
            <ExtraOutputs outputs={outputSpecs} primary={contract.primaryOutput} chosen={outputs} onChange={setOutputs} />
          </SetupRow>
        </ul>
        <SpendAndTiming
          waterfall={waterfall}
          noPrice={picked.every((k) => lookupCents(offering.find((p) => p.key === k)?.defaultCostCents ?? 0, actionOf(k)) === 0)}
          {...{ maxCost, setMaxCost, maxCredits, setMaxCredits, waitOnLimit, setWaitOnLimit, autoRun, setAutoRun, delay, setDelay, reuseDays, setReuseDays }}
        />
        <FieldError>{error}</FieldError>
      </div>
      <CreateFooter blocker={blocker} summary={preview && !uncovered ? fullRunText(preview) : null} busy={busy} onBack={onBack} onSave={save} backLabel={backLabel} />
    </>
  );
}

/** Any other action a connected provider offers (a Custom HTTP API, Hunter's company search): one provider, one action. */
function OtherActionForm({ tableId, columns, afterColumnId, onClose, onSaved, usable, onBack, onConnect }: Props & { usable: ProviderView[]; onBack: () => void; onConnect: () => void }) {
  const cellRequest = useCellRequest();
  const shared = new Set<string>(OUTCOMES.map((o) => o.actionKey));
  const options = usable.flatMap((p) => p.actions.filter((a) => !shared.has(a.key)).map((a) => ({ provider: p, action: a })));
  const [choice, setChoice] = useState(options[0] ? `${options[0].provider.key}:${options[0].action.key}` : "");
  const picked = options.find((o) => `${o.provider.key}:${o.action.key}` === choice);
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [outputs, setOutputs] = useState<string[] | null>(null);
  const [reuseDays, setReuseDays] = useState(String(DEFAULT_REUSE_DAYS));
  const [autoRun, setAutoRun] = useState(false);
  const [delay, setDelay] = useState("0");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const action = picked?.action;
  // Inputs and outputs follow the action; a pick the person has not touched takes the guess and the primary output.
  const mapped: Record<string, string> = Object.fromEntries((action?.inputs ?? []).map((i) => [i.key, inputs[i.key] ?? guessColumn(i, columns) ?? ""]));
  const chosenOutputs = outputs ?? [];
  const missingInput = action?.inputs.find((i) => i.required && !mapped[i.key]);
  const uncovered = action && !inputsCovered(action, (key) => !!mapped[key]) ? action : undefined;
  const blocker = blockerOf({ stepCount: picked ? 1 : 0, noProvider: "Connect a provider with another action.", missingInput, uncovered });

  async function save(run: boolean) {
    if (!picked) return;
    setBusy(true);
    setError(null);
    const body = {
      kind: "enrichment",
      providerKey: picked.provider.key,
      actionKey: picked.action.key,
      inputs: Object.fromEntries(Object.entries(mapped).filter(([, v]) => v)),
      selectedOutputs: chosenOutputs,
      afterColumnId: afterColumnId ?? columns[columns.length - 1]?.id,
      autoRun,
      ...toRunSettingsBody({ delay, reuseDays }),
    };
    const res = await createColumn(cellRequest, tableId, body, run);
    if (!res.ok) {
      setBusy(false);
      return setError(res.error);
    }
    await onSaved(res.key);
    onClose();
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>Other actions</DialogTitle>
        <DialogDescription>Actions outside the four shared outcomes, such as a Custom HTTP API. Nothing runs until you press Run.</DialogDescription>
      </DialogHeader>
      <div className="grid gap-4">
        <Field>
          <FieldLabel htmlFor="other-action">Action</FieldLabel>
          <ItemSelect
            id="other-action"
            items={options.map((o) => ({ value: `${o.provider.key}:${o.action.key}`, label: `${o.action.name} (${o.provider.name}, ${lookupPrice(o.provider.defaultCostCents, o.action).toLowerCase()})` }))}
            value={choice}
            onChange={(v) => {
              setChoice(v);
              setInputs({});
              setOutputs(null);
            }}
          />
        </Field>
        <Button type="button" variant="link" size="sm" className="h-auto w-fit p-0" onClick={onConnect}>
          Connect or manage providers
        </Button>
        {action && (
          <>
            <InputFields specs={action.inputs} inputs={mapped} setInputs={setInputs} columns={columns} uncovered={uncovered} missingInput={missingInput} />
            <ExtraOutputs outputs={action.outputs} primary={action.primaryOutput} chosen={chosenOutputs} onChange={setOutputs} />
            <SpendAndTiming
              waterfall={false}
              noPrice={false}
              maxCost=""
              setMaxCost={() => undefined}
              maxCredits=""
              setMaxCredits={() => undefined}
              waitOnLimit={false}
              setWaitOnLimit={() => undefined}
              {...{ autoRun, setAutoRun, delay, setDelay, reuseDays, setReuseDays }}
            />
          </>
        )}
        <FieldError>{error}</FieldError>
      </div>
      <CreateFooter blocker={blocker} busy={busy} onBack={onBack} onSave={save} />
    </>
  );
}
