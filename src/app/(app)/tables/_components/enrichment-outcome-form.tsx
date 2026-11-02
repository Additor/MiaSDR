"use client";

import { ArrowDownIcon, ArrowUpIcon } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { DEFAULT_REUSE_DAYS } from "@/contexts/grid/enrichment/domain/enrichment-config";
import { contractAction } from "@/contexts/grid/enrichment/domain/enrichment-contracts";
import { inputsCovered } from "@/contexts/grid/enrichment/domain/enrichment-inputs";
import { useCellRequest } from "../_lib/data/cell-request";
import { coverageText, fullRunText, useEnrichmentPreview } from "../_lib/data/enrichment-preview";
import { SPEND_CAP_ERROR, spendCapInvalid, toCreateBody } from "../_lib/data/enrichment-request";
import { outcomeOf } from "../_lib/data/outcomes";
import { guessColumn, lookupCents, lookupPrice, type ActionSpec, type CatalogEntry, type ProviderView } from "../_lib/data/providers";
import { ColumnChips, ConnectProviders, SetupRow } from "./enrichment-setup";
import { blockerOf, CheckField, createColumn, CreateFooter, ExtraOutputs, InputFields, SpendAndTiming, type EnrichmentFormProps } from "./runner-form-parts";

/** "A, B and C". */
const listText = (items: string[]) => (items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`);

/**
 * One outcome as three lines that read as a sentence: which provider, what each row matches on, and the columns it adds.
 * Each line opens its fields with Change. Until a connected provider offers the outcome, the dialog shows only the
 * vendors that do, and the form keeps what you set while you connect one.
 */
export function EnrichmentOutcomeForm({ tableId, columns, afterColumnId, onClose, onSaved, actionKey, usable, providers, catalog, loadError, refresh, onBack, backLabel }: EnrichmentFormProps & { actionKey: string; usable: ProviderView[]; providers: ProviderView[]; catalog: CatalogEntry[]; loadError: string | null; refresh: () => Promise<void>; onBack: () => void; backLabel: string }) {
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
  const capInvalid = waterfall && spendCapInvalid(maxCost);
  const blocker =
    blockerOf({
      stepCount: picked.length,
      noProvider: offering.length === 0 ? `Connect a provider that can ${outcome.label.toLowerCase()}.` : "Tick a provider.",
      missingInput,
      uncovered,
    }) ?? (capInvalid ? SPEND_CAP_ERROR : null);
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
    const body = toCreateBody({
      name: columnName,
      steps: picked.map((providerKey) => ({ providerKey, actionKey })),
      inputs,
      selectedOutputs: outputs.filter((k) => outputSpecs.some((o) => o.key === k)),
      afterColumnId: afterColumnId ?? columns[columns.length - 1]?.id,
      autoRun,
      delay,
      reuseDays,
      stopAtCatchAll,
      maxCost,
      maxCredits,
      waitOnLimit,
    });
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
