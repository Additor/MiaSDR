"use client";

import { useMemo, useState } from "react";
import { CHOICE_TILE } from "@/components/shell/choice-card";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { FieldError } from "@/components/ui/field";
import { OUTCOMES, outcomeOf } from "../_lib/data/outcomes";
import { usableProviders, useProviders } from "../_lib/data/providers";
import { EnrichmentEditForm } from "./enrichment-edit-form";
import { EnrichmentOtherActionForm } from "./enrichment-other-action-form";
import { EnrichmentOutcomeForm } from "./enrichment-outcome-form";
import { ProviderManager } from "./provider-manager";
import type { EnrichmentFormProps } from "./runner-form-parts";

/** Adds an enrichment column from an outcome (one provider, or several tried in order as a waterfall), or edits one. */
export function EnrichmentDialog(props: EnrichmentFormProps) {
  return (
    <Dialog open onOpenChange={(open) => !open && props.onClose()}>
      <DialogContent className="max-h-[92svh] overflow-y-auto sm:max-w-2xl">
        {props.column ? <EnrichmentEditForm {...props} column={props.column} /> : <CreateBody {...props} />}
      </DialogContent>
    </Dialog>
  );
}

type CreateView = { kind: "outcomes" } | { kind: "outcome"; actionKey: string } | { kind: "other" } | { kind: "connect"; back: CreateView };

/**
 * Adding an enrichment starts from what the column should hold: one of the four shared outcomes, or another action a
 * provider offers. Vendors are a choice inside the outcome, and ticking a second one makes the column a waterfall.
 * Connecting a provider is its own view, so the list of vendors never sits in the way of the form.
 */
function CreateBody(props: EnrichmentFormProps) {
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
      <EnrichmentOutcomeForm
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
  if (view.kind === "other") return <EnrichmentOtherActionForm {...props} usable={usable} onBack={() => setView({ kind: "outcomes" })} onConnect={connect} />;

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
