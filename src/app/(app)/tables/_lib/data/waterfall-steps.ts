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
/** The one line under the folded "Spend and timing" section: "Manual runs · reuse 30 days · up to 2 credits a cell". */
export function spendSummary(s: { autoRun: boolean; delay: string; reuseDays: string; maxCost?: string; maxCredits?: string; waitOnLimit?: boolean }): string {
  const parts = [s.autoRun ? "Runs automatically" : "Manual runs"];
  const delay = Math.floor(Number(s.delay) || 0);
  if (delay > 0) parts.push(`${delay} s between calls`);
  const reuse = Math.floor(Number(s.reuseDays) || 0);
  parts.push(reuse > 0 ? `reuse ${reuse} ${reuse === 1 ? "day" : "days"}` : "no reuse");
  if (s.maxCredits?.trim()) parts.push(`up to ${Number(s.maxCredits)} credits a cell`);
  if (s.maxCost?.trim()) parts.push(`up to ${Number(s.maxCost)}c a cell`);
  if (s.waitOnLimit) parts.push("waits for rate limits");
  return parts.join(" · ");
}

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
