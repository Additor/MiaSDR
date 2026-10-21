import { ValidationError } from "@/shared/errors";
import { catalogEntry } from "../domain/enrichment-catalog";
import { RUNNABLE_TYPES } from "../domain/enrichment-cascade";
import { aiConfigSchema, enrichmentConfigSchema, waterfallConfigSchema } from "../domain/enrichment-config";
import type { ActionSpec } from "../domain/enrichment-catalog";
import type { AdapterRegistry, CascadeSpec, ColumnRow, ProviderRecord, ProviderStore } from "./enrichment-ports";

interface CostDeps {
  providers: ProviderStore;
  adapters: AdapterRegistry;
}

/** Cents one call to this action costs when the adapter does not report a price. */
export function estimateStepCents(provider: ProviderRecord, action: ActionSpec | undefined): number {
  return Math.max(provider.defaultCostCents, action?.defaultCostCents ?? 0);
}

/** What one cell of a column can spend at worst, in cents and vendor credits, and with which providers. */
export interface ColumnEstimate {
  cents: number;
  credits: number;
  providers: ProviderEstimate[];
  /** False when no step can ever call anyone (every provider disconnected or without its key). */
  reachable: boolean;
}

export interface ProviderEstimate {
  key: string;
  name: string;
  calls: number;
  credits: number;
  cents: number;
}

/**
 * Worst-case spend of one cell. `strict` refuses a column with a provider that is off, missing or without its key (a
 * person's run). Otherwise a missing provider or key is left out, as the worker skips it, and a switched-off provider
 * counts, because its cells wait and call it later (an auto-run cascade).
 */
export async function estimateColumn(deps: CostDeps, organizationId: string, column: ColumnRow, strict: boolean): Promise<ColumnEstimate> {
  if (column.type === "ai") {
    if (!aiConfigSchema.safeParse(column.config).success) throw new ValidationError(`“${column.name}” has an invalid configuration. Save it again.`);
    return { cents: 0, credits: 0, providers: [], reachable: true };
  }
  const parsed = column.type === "enrichment" ? enrichmentConfigSchema.safeParse(column.config) : waterfallConfigSchema.safeParse(column.config);
  if (!parsed.success) throw new ValidationError(`“${column.name}” has an invalid configuration. Save it again.`);
  const steps = "steps" in parsed.data ? parsed.data.steps : [{ providerKey: parsed.data.providerKey, actionKey: parsed.data.actionKey }];
  const providers: ProviderEstimate[] = [];
  for (const step of steps) {
    const refuse = (message: string) => {
      if (strict) throw new ValidationError(message);
    };
    const provider = await deps.providers.getByKey(organizationId, step.providerKey);
    // A switched-off provider pauses its cells and is called once it is on, so the lenient estimate still counts it.
    if (!provider || (!provider.enabled && strict)) {
      refuse(`Connect and enable the "${step.providerKey}" provider before running “${column.name}”.`);
      continue;
    }
    const adapter = deps.adapters.adapterFor(provider);
    const action = adapter?.actions(provider).find((a) => a.key === step.actionKey);
    if (!adapter || !action) {
      refuse(`“${column.name}” uses an action that provider "${step.providerKey}" does not offer.`);
      continue;
    }
    const needsKey = catalogEntry(adapter.adapter)?.credentialFields.some((f) => f.required);
    if (needsKey && !provider.hasCredential) {
      refuse(`Add the API key for "${step.providerKey}" before running “${column.name}”.`);
      continue;
    }
    providers.push({ key: provider.key, name: provider.name, calls: 1, credits: action.creditsPerCall ?? 0, cents: estimateStepCents(provider, action) });
  }
  const cents = providers.reduce((sum, p) => sum + p.cents, 0);
  const credits = providers.reduce((sum, p) => sum + p.credits, 0);
  const capCents = "maxCostCents" in parsed.data ? parsed.data.maxCostCents : undefined;
  const capCredits = "maxCredits" in parsed.data ? parsed.data.maxCredits : undefined;
  return {
    cents: capCents === undefined ? cents : Math.min(cents, capCents),
    credits: capCredits === undefined ? credits : Math.min(credits, capCredits),
    providers,
    reachable: providers.length > 0,
  };
}

/** Checks that every provider a column calls is connected, switched on and has its key. Returns the worst-case cents per cell. */
export async function preflight(deps: CostDeps, organizationId: string, column: ColumnRow): Promise<number> {
  return (await estimateColumn(deps, organizationId, column, true)).cents;
}

/** Worst-case cents of one cell of this column, counting only the steps that can run. A broken column costs nothing. */
export async function cellCents(deps: CostDeps, organizationId: string, column: ColumnRow): Promise<number> {
  return (await cellEstimate(deps, organizationId, column)).cents;
}

/**
 * The lenient estimate. An invalid configuration costs nothing and still counts as reachable: its cell fails with
 * "Save it again", which tells the person what to fix, where a column whose providers are all off would only fail.
 */
export async function cellEstimate(deps: CostDeps, organizationId: string, column: ColumnRow): Promise<ColumnEstimate> {
  try {
    return await estimateColumn(deps, organizationId, column, false);
  } catch (error) {
    if (error instanceof ValidationError) return { cents: 0, credits: 0, providers: [], reachable: true };
    throw error;
  }
}

/** Worst-case cents per runnable column that reads one of `writtenKeys`, for the finishing write's own cascade. */
export async function cascadeSpecFor(deps: CostDeps, organizationId: string, columns: readonly ColumnRow[], writtenKeys: readonly string[]): Promise<CascadeSpec> {
  const centsByColumn: Record<string, number> = {};
  const unreachable: string[] = [];
  for (const column of columns) {
    if (!column.autoRun || !RUNNABLE_TYPES.has(column.type) || !column.dependsOn.some((d) => writtenKeys.includes(d))) continue;
    const estimate = await cellEstimate(deps, organizationId, column);
    // A column whose every provider is disconnected would only queue a cell that fails.
    if (!estimate.reachable) unreachable.push(column.key);
    else centsByColumn[column.key] = estimate.cents;
  }
  return { centsByColumn, unreachable };
}
