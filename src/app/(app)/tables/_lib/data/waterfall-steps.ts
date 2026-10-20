/**
 * Step choices for a waterfall. Steps share their inputs and outputs only when they run the same action, so after the
 * first step the dialog offers only providers that have the first step's action, and presets line up every provider
 * that offers a shared contract.
 */

export interface WaterfallStep {
  providerKey: string;
  actionKey: string;
}

interface StepProvider {
  key: string;
  actions: ReadonlyArray<{ key: string }>;
}

/** Contracts every vendor offering them answers the same way (src/contexts/grid/domain/enrichment-contracts.ts). */
export const WATERFALL_PRESETS = [
  { actionKey: "verify-email", label: "Verify email" },
  { actionKey: "find-work-email", label: "Find work email" },
] as const;

const offers = (provider: StepProvider, actionKey: string) => provider.actions.some((a) => a.key === actionKey);

/** Providers step `index` may use: any for the first step, then those that offer the first step's action. */
export function providersForStep<P extends StepProvider>(usable: readonly P[], steps: readonly WaterfallStep[], index: number): P[] {
  if (index === 0 || steps.length === 0) return [...usable];
  return usable.filter((p) => offers(p, steps[0].actionKey));
}

/** The step "Add step" appends: the next provider with the first step's action that the waterfall does not use yet. */
export function nextStep(usable: readonly StepProvider[], steps: readonly WaterfallStep[]): WaterfallStep | null {
  if (steps.length === 0) {
    const first = usable.find((p) => p.actions.length > 0);
    return first ? { providerKey: first.key, actionKey: first.actions[0].key } : null;
  }
  const actionKey = steps[0].actionKey;
  const used = new Set(steps.map((s) => s.providerKey));
  const provider = usable.find((p) => !used.has(p.key) && offers(p, actionKey));
  return provider ? { providerKey: provider.key, actionKey } : null;
}

/** Every usable provider that offers the action, in list order. A preset is worth showing at two or more. */
export function presetSteps(usable: readonly StepProvider[], actionKey: string): WaterfallStep[] {
  return usable.filter((p) => offers(p, actionKey)).map((p) => ({ providerKey: p.key, actionKey }));
}
