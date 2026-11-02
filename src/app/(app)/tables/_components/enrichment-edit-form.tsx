"use client";

import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldError, FieldGroup, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field";
import { MAX_REUSE_DAYS } from "@/contexts/grid/enrichment/domain/enrichment-config";
import { gridUrl } from "../_lib/data/client";
import { useCellRequest } from "../_lib/data/cell-request";
import { editFormOf, toEditPatch } from "../_lib/data/enrichment-request";
import { usableProviders, useProviders } from "../_lib/data/providers";
import type { GridColumn } from "../_lib/data/types";
import type { WaterfallStep } from "../_lib/data/waterfall-steps";
import { ColumnSelect } from "./form-bits";
import { CheckField, NumberField, REUSE_LABEL, RunTiming, WAIT_LABEL, type EnrichmentFormProps } from "./runner-form-parts";

/** "companyDomain" to "Company domain", for an input whose action is not available (its provider is gone). */
const inputLabel = (key: string) => key.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase()).replace(/ ([A-Z])/g, (_, c: string) => ` ${c.toLowerCase()}`);

/** Edits the inputs, spend caps and timing of an existing enrichment or waterfall column. */
export function EnrichmentEditForm({ tableId, columns, column, onClose, onSaved }: EnrichmentFormProps & { column: GridColumn }) {
  const cellRequest = useCellRequest();
  const { providers, catalog } = useProviders();
  const config = column.config as { providerKey?: string; actionKey?: string; steps?: WaterfallStep[] };
  const isWaterfall = column.type === "waterfall";
  const steps: WaterfallStep[] = isWaterfall ? (config.steps ?? []) : config.providerKey && config.actionKey ? [{ providerKey: config.providerKey, actionKey: config.actionKey }] : [];
  const actionKey = steps[0]?.actionKey;
  const initial = editFormOf(column);
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
    const result = toEditPatch(form, initial, { columnId: column.id, isWaterfall });
    if ("error" in result) return setError(result.error);
    if (!result.patch) return onClose();
    setBusy(true);
    setError(null);
    const res = await cellRequest(gridUrl.sub(tableId, "enrichments"), "PATCH", result.patch);
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
