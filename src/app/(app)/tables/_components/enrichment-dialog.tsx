"use client";

import { ArrowDownIcon, ArrowUpIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { gridRequest, gridUrl } from "../_lib/data/client";
import { DEFAULT_REUSE_DAYS } from "@/contexts/grid/enrichment/domain/enrichment-config";
import { SETTLED_STATUSES } from "@/contexts/grid/enrichment/domain/enrichment-contracts";
import { acceptsText, inputsCovered } from "@/contexts/grid/enrichment/domain/enrichment-inputs";
import { guessColumn, usableProviders, useProviders, type ActionSpec, type ProviderView } from "../_lib/data/providers";
import type { GridColumn } from "../_lib/data/types";
import { nextStep, presetSteps, providersForStep, spendSummary, WATERFALL_PRESETS, type WaterfallStep } from "../_lib/data/waterfall-steps";
import { ColumnChoice, Choice, ErrorText, Field } from "./form-bits";
import { ProviderManager } from "./provider-manager";

interface Props {
  tableId: string;
  columns: GridColumn[];
  /** Set to edit the inputs and timing of an existing enrichment or waterfall column. */
  column: GridColumn | null;
  afterColumnId?: string;
  onClose: () => void;
  onSaved: () => Promise<void>;
}

type Step = WaterfallStep;

/** Adds an enrichment (one provider action) or a waterfall (several, tried in order) column. */
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
    maxCost: config.maxCostCents === undefined ? "" : String(config.maxCostCents),
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
    if (form.delay !== initial.delay) patch.delaySeconds = Math.max(0, Math.min(3600, Math.floor(Number(form.delay) || 0)));
    if (form.reuseDays !== initial.reuseDays) patch.reuseDays = Math.max(0, Math.min(365, Math.floor(Number(form.reuseDays) || 0)));
    if (form.stopAtCatchAll !== initial.stopAtCatchAll) patch.settledStatuses = form.stopAtCatchAll ? [...SETTLED_STATUSES, "catch_all"] : null;
    if (isWaterfall) {
      const cap = (text: string) => (text.trim() === "" ? null : Math.max(0, Number(text) || 0));
      if (form.maxCost !== initial.maxCost) patch.maxCostCents = cap(form.maxCost);
      if (form.maxCredits !== initial.maxCredits) patch.maxCredits = cap(form.maxCredits);
      if (form.waitOnLimit !== initial.waitOnLimit) patch.onRateLimit = form.waitOnLimit ? "wait" : "next";
    }
    if (Object.keys(patch).length === 1) return onClose();
    setBusy(true);
    setError(null);
    const res = await gridRequest(gridUrl.sub(tableId, "enrichments"), "PATCH", patch);
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
      <div className="grid gap-3">
        <fieldset className="grid gap-2">
          <legend className="mb-1 text-sm font-medium">Inputs</legend>
          {specs.map((input) => (
            <Field key={input.key} label={`${input.name}${input.required ? " (required)" : ""}`} htmlFor={`edit-in-${input.key}`}>
              <ColumnChoice id={`edit-in-${input.key}`} value={form.inputs[input.key] || null} none={input.required ? undefined : "Not used"} onChange={(v) => set("inputs", { ...form.inputs, [input.key]: v ?? "" })} columns={sources} />
            </Field>
          ))}
        </fieldset>
        {actionKey === "verify-email" && (
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={form.stopAtCatchAll} onCheckedChange={(v) => set("stopAtCatchAll", v === true)} />
            {isWaterfall ? "Stop at a catch-all verdict instead of asking the next verifier" : "Count a catch-all verdict as found"}
          </label>
        )}
        {isWaterfall && (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Spend cap per cell (cents)" htmlFor="edit-cap" hint="Optional. A step that would pass it is skipped. Leave empty for no cap.">
              <Input id="edit-cap" type="number" min={0} value={form.maxCost} onChange={(e) => set("maxCost", e.target.value)} className="w-28" />
            </Field>
            <Field label="Credit cap per cell" htmlFor="edit-credits" hint="Optional. Counts vendor credits. Leave empty for no cap.">
              <Input id="edit-credits" type="number" min={0} step={0.5} value={form.maxCredits} onChange={(e) => set("maxCredits", e.target.value)} className="w-28" />
            </Field>
            <label className="flex items-center gap-2 text-sm sm:col-span-2">
              <Checkbox checked={form.waitOnLimit} onCheckedChange={(v) => set("waitOnLimit", v === true)} />
              Wait for a rate-limited step instead of asking the next one
            </label>
          </div>
        )}
        <Field label="Reuse an answer for the same lookup (days)" htmlFor="edit-reuse" hint="0 always asks the provider.">
          <Input id="edit-reuse" type="number" min={0} max={365} value={form.reuseDays} onChange={(e) => set("reuseDays", e.target.value)} className="w-28" />
        </Field>
        <RunTiming autoRun={form.autoRun} setAutoRun={(v) => set("autoRun", v)} delay={form.delay} setDelay={(v) => set("delay", v)} />
        <ErrorText>{error}</ErrorText>
      </div>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button type="button" onClick={save} disabled={busy}>
          {busy ? "Saving..." : "Save"}
        </Button>
      </DialogFooter>
    </>
  );
}

export function RunTiming({ autoRun, setAutoRun, delay, setDelay }: { autoRun: boolean; setAutoRun: (v: boolean) => void; delay: string; setDelay: (v: string) => void }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <label className="flex items-center gap-2 text-sm">
        <Checkbox checked={autoRun} onCheckedChange={(v) => setAutoRun(v === true)} />
        Run automatically when its inputs change
      </label>
      <Field label="Delay before each call (seconds)" htmlFor="run-delay">
        <Input id="run-delay" type="number" min={0} max={3600} value={delay} onChange={(e) => setDelay(e.target.value)} className="w-28" />
      </Field>
    </div>
  );
}

function CreateBody({ tableId, columns, afterColumnId, onClose, onSaved }: Props) {
  const { catalog, providers, loading, error: loadError, refresh } = useProviders();
  const usable = useMemo(() => usableProviders(providers, catalog), [providers, catalog]);
  const [mode, setMode] = useState<"single" | "waterfall">("single");
  // Unset follows the providers: the list opens by itself while none is ready, since connecting one is the next step.
  const [showProviders, setShowProviders] = useState<boolean | null>(null);

  const [steps, setSteps] = useState<Step[]>([]);
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [outputs, setOutputs] = useState<string[]>([]);
  const [name, setName] = useState("");
  const [maxCost, setMaxCost] = useState("");
  const [maxCredits, setMaxCredits] = useState("");
  const [waitOnLimit, setWaitOnLimit] = useState(false);
  const [reuseDays, setReuseDays] = useState(String(DEFAULT_REUSE_DAYS));
  const [stopAtCatchAll, setStopAtCatchAll] = useState(false);
  const [autoRun, setAutoRun] = useState(false);
  const [delay, setDelay] = useState("0");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const providersOpen = showProviders ?? (!loading && usable.length === 0);
  const actionOf = (step: Step): ActionSpec | undefined => usable.find((p) => p.key === step.providerKey)?.actions.find((a) => a.key === step.actionKey);
  const chosen = steps.map(actionOf).filter((a): a is ActionSpec => !!a);

  // Union of the action inputs of every step, and the outputs every step offers.
  const inputSpecs = useMemo(() => {
    const map = new Map<string, { key: string; name: string; type: string; required: boolean }>();
    for (const a of chosen) for (const i of a.inputs) map.set(i.key, { ...i, required: (map.get(i.key)?.required ?? false) || i.required });
    return [...map.values()];
  }, [chosen]);
  const outputSpecs = useMemo(() => {
    if (chosen.length === 0) return [];
    const [first, ...rest] = chosen;
    return first.outputs.filter((o) => rest.every((a) => a.outputs.some((x) => x.key === o.key)));
  }, [chosen]);

  function setStep(index: number, next: Step) {
    let list = steps.map((s, i) => (i === index ? next : s));
    // A new first action keeps only the later steps whose provider offers it too.
    if (index === 0 && mode === "waterfall") {
      list = [next, ...list.slice(1).filter((s) => usable.find((p) => p.key === s.providerKey)?.actions.some((a) => a.key === next.actionKey)).map((s) => ({ ...s, actionKey: next.actionKey }))];
    }
    applySteps(list);
  }
  function applySteps(list: Step[]) {
    setSteps(list);
    const actions = list.map((s) => usable.find((p) => p.key === s.providerKey)?.actions.find((a) => a.key === s.actionKey)).filter((a): a is ActionSpec => !!a);
    const nextInputs: Record<string, string> = {};
    for (const a of actions) for (const i of a.inputs) if (!nextInputs[i.key]) nextInputs[i.key] = inputs[i.key] ?? guessColumn(i, columns) ?? "";
    setInputs(nextInputs);
    if (actions.length > 0) {
      const first = actions[0];
      const common = first.outputs.filter((o) => actions.every((a) => a.outputs.some((x) => x.key === o.key)));
      const keep = outputs.filter((k) => common.some((o) => o.key === k));
      setOutputs(keep.length > 0 ? keep : common.filter((o) => o.key === first.primaryOutput).map((o) => o.key));
    } else setOutputs([]);
  }
  function defaultStep(p: ProviderView): Step {
    return { providerKey: p.key, actionKey: p.actions[0].key };
  }
  function switchMode(next: "single" | "waterfall") {
    setMode(next);
    if (next === "single" && steps.length > 1) applySteps(steps.slice(0, 1));
  }
  function addStep() {
    const step = nextStep(usable, steps);
    if (step) applySteps([...steps, step]);
  }
  const canAdd = nextStep(usable, steps) !== null;
  const presets = WATERFALL_PRESETS.map((preset) => ({ ...preset, steps: presetSteps(usable, preset.actionKey) })).filter((preset) => preset.steps.length >= 2);
  function move(i: number, d: -1 | 1) {
    const list = steps.slice();
    const j = i + d;
    if (j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    applySteps(list);
  }

  const missingInput = inputSpecs.find((i) => i.required && !inputs[i.key]);
  // An action that matches on several identities needs one of its combinations mapped.
  const uncovered = chosen.find((a) => !inputsCovered(a, (key) => !!inputs[key]));
  const ready = steps.length > 0 && chosen.length === steps.length && !missingInput && !uncovered && outputs.length > 0 && (mode === "single" || steps.length >= 2);

  async function save() {
    setBusy(true);
    setError(null);
    const cleanInputs = Object.fromEntries(Object.entries(inputs).filter(([, v]) => v));
    const base = {
      inputs: cleanInputs,
      selectedOutputs: outputs,
      afterColumnId: afterColumnId ?? columns[columns.length - 1]?.id,
      autoRun,
      delaySeconds: Math.max(0, Math.min(3600, Math.floor(Number(delay) || 0))),
      reuseDays: Math.max(0, Math.min(365, Math.floor(Number(reuseDays) || 0))),
      ...(mode === "waterfall" && stopAtCatchAll && steps[0]?.actionKey === "verify-email" ? { settledStatuses: [...SETTLED_STATUSES, "catch_all"] } : {}),
    };
    const body =
      mode === "single"
        ? { kind: "enrichment", providerKey: steps[0].providerKey, actionKey: steps[0].actionKey, ...base }
        : { kind: "waterfall", name: name.trim() || undefined, steps, ...base, ...(maxCost.trim() !== "" ? { maxCostCents: Math.max(0, Number(maxCost) || 0) } : {}), ...(maxCredits.trim() !== "" ? { maxCredits: Math.max(0, Number(maxCredits) || 0) } : {}), ...(waitOnLimit ? { onRateLimit: "wait" } : {}) };
    const res = await gridRequest(gridUrl.sub(tableId, "enrichments"), "POST", body);
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
        <DialogTitle>Add enrichment</DialogTitle>
        <DialogDescription>Fill columns from a data provider. Nothing runs until you press Run. Provider calls use your own account and key.</DialogDescription>
      </DialogHeader>
      <div className="grid gap-4">
        <div
          role="tablist"
          aria-label="Kind"
          className="inline-flex w-fit rounded-lg border p-0.5"
          onKeyDown={(e) => {
            // Arrow keys move between the two kinds, as a tab list does.
            if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
            e.preventDefault();
            const next = mode === "single" ? "waterfall" : "single";
            switchMode(next);
            document.getElementById(`enrichment-tab-${next}`)?.focus();
          }}
        >
          {(["single", "waterfall"] as const).map((m) => (
            <button
              key={m}
              id={`enrichment-tab-${m}`}
              type="button"
              role="tab"
              aria-selected={mode === m}
              aria-controls="enrichment-panel"
              tabIndex={mode === m ? 0 : -1}
              className={`rounded-md px-3 py-1 text-sm ${mode === m ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}
              onClick={() => switchMode(m)}
            >
              {m === "single" ? "One provider" : "Waterfall"}
            </button>
          ))}
        </div>
        <div role="tabpanel" id="enrichment-panel" aria-labelledby={`enrichment-tab-${mode}`} className="grid gap-3">
          {mode === "waterfall" && <p className="text-xs text-muted-foreground">A waterfall tries each step in order and stops at the first hit. Every step runs the same action, so their answers fill the same columns.</p>}
          {mode === "waterfall" && presets.length > 0 && (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs text-muted-foreground">Start from</span>
              {presets.map((preset) => (
                <Button key={preset.actionKey} type="button" variant="outline" size="sm" onClick={() => applySteps(preset.steps)}>
                  {preset.label} ({preset.steps.length} providers)
                </Button>
              ))}
            </div>
          )}

          {loading ? (
            <p className="text-sm text-muted-foreground">Loading providers...</p>
          ) : (
            <>
              <ErrorText>{loadError}</ErrorText>
              {usable.length === 0 && <p className="rounded-lg border border-dashed p-3 text-sm">No provider is ready yet. Connect one in the list below; MiaSDR checks the key before it saves it.</p>}
              {steps.map((step, i) => {
                const provider = usable.find((p) => p.key === step.providerKey);
                const later = mode === "waterfall" && i > 0;
                return (
                  <div key={i} className="grid gap-2 rounded-lg border p-3 sm:grid-cols-[1fr_1fr_auto]">
                    <Field label={mode === "waterfall" ? `Step ${i + 1} provider` : "Provider"} htmlFor={`step-p-${i}`}>
                      <Choice
                        id={`step-p-${i}`}
                        items={providersForStep(usable, steps, later ? i : 0).map((p) => ({ value: p.key, label: p.name }))}
                        value={step.providerKey}
                        onChange={(k) => {
                          const p = usable.find((x) => x.key === k);
                          if (p) setStep(i, later ? { providerKey: p.key, actionKey: steps[0].actionKey } : defaultStep(p));
                        }}
                      />
                    </Field>
                    <Field label="Action" htmlFor={`step-a-${i}`}>
                      <Choice
                        id={`step-a-${i}`}
                        items={(provider?.actions ?? []).filter((a) => !later || a.key === steps[0].actionKey).map((a) => ({ value: a.key, label: a.name }))}
                        value={step.actionKey}
                        onChange={(a) => setStep(i, { ...step, actionKey: a })}
                      />
                    </Field>
                    {mode === "waterfall" && (
                      <div className="flex items-end gap-1">
                        <Button type="button" size="icon" variant="ghost" aria-label="Move step up" disabled={i === 0} onClick={() => move(i, -1)}>
                          <ArrowUpIcon />
                        </Button>
                        <Button type="button" size="icon" variant="ghost" aria-label="Move step down" disabled={i === steps.length - 1} onClick={() => move(i, 1)}>
                          <ArrowDownIcon />
                        </Button>
                        <Button type="button" size="icon" variant="ghost" aria-label="Remove step" onClick={() => applySteps(steps.filter((_, j) => j !== i))}>
                          <Trash2Icon />
                        </Button>
                      </div>
                    )}
                  </div>
                );
              })}
              {usable.length > 0 && (mode === "waterfall" || steps.length === 0) && (
                <div>
                  <Button type="button" variant="outline" size="sm" onClick={addStep} disabled={!canAdd}>
                    <PlusIcon /> {steps.length === 0 ? "Choose provider" : "Add step"}
                  </Button>
                </div>
              )}
            </>
          )}

          {chosen.length > 0 && (
            <>
              <fieldset className="grid gap-2">
                <legend className="mb-1 text-sm font-medium">Inputs</legend>
                {inputSpecs.map((input) => (
                  <Field key={input.key} label={`${input.name}${input.required ? " (required)" : ""}`} htmlFor={`in-${input.key}`}>
                    <ColumnChoice id={`in-${input.key}`} value={inputs[input.key] || null} none={input.required ? undefined : "Not used"} onChange={(v) => setInputs((s) => ({ ...s, [input.key]: v ?? "" }))} columns={columns} />
                  </Field>
                ))}
                {!missingInput && uncovered && <p className="text-sm text-muted-foreground">Map {acceptsText(uncovered)}.</p>}
              </fieldset>
              <fieldset className="stack-field">
                <legend className="mb-1 text-sm font-medium">Columns to add</legend>
                {outputSpecs.length === 0 && <p className="text-sm text-muted-foreground">These steps share no output. Pick actions that return the same fields.</p>}
                {outputSpecs.map((o) => (
                  <label key={o.key} className="flex items-center gap-2 text-sm">
                    <Checkbox checked={outputs.includes(o.key)} onCheckedChange={(v) => setOutputs((s) => (v === true ? [...s, o.key] : s.filter((k) => k !== o.key)))} />
                    {o.name}
                  </label>
                ))}
              </fieldset>
              {mode === "waterfall" && (
                <div className="grid gap-3">
                  <Field label="Column name" htmlFor="wf-name">
                    <Input id="wf-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Waterfall" />
                  </Field>
                  {steps[0]?.actionKey === "verify-email" && (
                    <label className="flex items-center gap-2 text-sm">
                      <Checkbox checked={stopAtCatchAll} onCheckedChange={(v) => setStopAtCatchAll(v === true)} />
                      Stop at a catch-all verdict instead of asking the next verifier
                    </label>
                  )}
                </div>
              )}
              <details className="group rounded-lg border">
                <summary className="flex cursor-pointer list-none items-baseline justify-between gap-3 px-3 py-2 text-sm">
                  <span className="font-medium">Spend and timing</span>
                  <span className="truncate text-xs text-muted-foreground">{spendSummary({ autoRun, delay, reuseDays, ...(mode === "waterfall" ? { maxCost, maxCredits, waitOnLimit } : {}) })}</span>
                </summary>
                <div className="grid gap-3 border-t px-3 py-3">
                  {mode === "waterfall" && (
                    <div className="grid gap-3 sm:grid-cols-2">
                      <Field
                        label="Spend cap per cell (cents)"
                        htmlFor="wf-cap"
                        hint={
                          maxCost.trim() !== "" && steps.every((s) => (usable.find((p) => p.key === s.providerKey)?.defaultCostCents ?? 0) === 0)
                            ? "These providers have no price, so a cents cap never stops a call. Use the credit cap."
                            : "Optional. A step that would pass it is skipped."
                        }
                      >
                        <Input id="wf-cap" type="number" min={0} value={maxCost} onChange={(e) => setMaxCost(e.target.value)} className="w-28" />
                      </Field>
                      <Field label="Credit cap per cell" htmlFor="wf-credits" hint="Optional. Counts vendor credits, such as Hunter's half credit per verification.">
                        <Input id="wf-credits" type="number" min={0} step={0.5} value={maxCredits} onChange={(e) => setMaxCredits(e.target.value)} className="w-28" />
                      </Field>
                      <label className="flex items-center gap-2 text-sm sm:col-span-2">
                        <Checkbox checked={waitOnLimit} onCheckedChange={(v) => setWaitOnLimit(v === true)} />
                        Wait for a rate-limited step instead of asking the next one
                      </label>
                    </div>
                  )}
                  <RunTiming autoRun={autoRun} setAutoRun={setAutoRun} delay={delay} setDelay={setDelay} />
                  <Field label="Reuse an answer for the same lookup (days)" htmlFor="reuse-days" hint="A vendor answered the same input within this many days: the cell takes that answer and pays nothing. 0 always asks.">
                    <Input id="reuse-days" type="number" min={0} max={365} value={reuseDays} onChange={(e) => setReuseDays(e.target.value)} className="w-28" />
                  </Field>
                </div>
              </details>
            </>
          )}
        </div>
        <div>
          <Button type="button" variant="link" size="sm" className="h-auto p-0" onClick={() => setShowProviders(!providersOpen)} aria-expanded={providersOpen}>
            {providersOpen ? "Hide providers" : usable.length === 0 ? "Connect a provider" : "Connect or manage providers"}
          </Button>
          {providersOpen && (
            <div className="mt-2">
              <ProviderManager catalog={catalog} providers={providers} onChanged={refresh} />
            </div>
          )}
        </div>

        <ErrorText>{error}</ErrorText>
      </div>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button type="button" onClick={save} disabled={!ready || busy}>
          {busy ? "Adding..." : "Add columns"}
        </Button>
      </DialogFooter>
    </>
  );
}
