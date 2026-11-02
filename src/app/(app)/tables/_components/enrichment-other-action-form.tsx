"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { DEFAULT_REUSE_DAYS } from "@/contexts/grid/enrichment/domain/enrichment-config";
import { inputsCovered } from "@/contexts/grid/enrichment/domain/enrichment-inputs";
import { useCellRequest } from "../_lib/data/cell-request";
import { toCreateBody } from "../_lib/data/enrichment-request";
import { OUTCOMES } from "../_lib/data/outcomes";
import { guessColumn, lookupPrice, type ProviderView } from "../_lib/data/providers";
import { ItemSelect } from "./form-bits";
import { blockerOf, createColumn, CreateFooter, ExtraOutputs, InputFields, SpendAndTiming, type EnrichmentFormProps } from "./runner-form-parts";

/** Any other action a connected provider offers (a Custom HTTP API, Hunter's company search): one provider, one action. */
export function EnrichmentOtherActionForm({ tableId, columns, afterColumnId, onClose, onSaved, usable, onBack, onConnect }: EnrichmentFormProps & { usable: ProviderView[]; onBack: () => void; onConnect: () => void }) {
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
    const body = toCreateBody({
      steps: [{ providerKey: picked.provider.key, actionKey: picked.action.key }],
      inputs: mapped,
      selectedOutputs: chosenOutputs,
      afterColumnId: afterColumnId ?? columns[columns.length - 1]?.id,
      autoRun,
      delay,
      reuseDays,
    });
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
