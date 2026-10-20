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

/** Checks that every provider a column calls is connected, switched on and has its key. Returns the worst-case cents per cell. */
export async function preflight(deps: CostDeps, organizationId: string, column: ColumnRow): Promise<number> {
  if (column.type === "ai") {
    if (!aiConfigSchema.safeParse(column.config).success) throw new ValidationError(`“${column.name}” has an invalid configuration. Save it again.`);
    return 0;
  }
  const parsed = column.type === "enrichment" ? enrichmentConfigSchema.safeParse(column.config) : waterfallConfigSchema.safeParse(column.config);
  if (!parsed.success) throw new ValidationError(`“${column.name}” has an invalid configuration. Save it again.`);
  const steps = "steps" in parsed.data ? parsed.data.steps : [{ providerKey: parsed.data.providerKey, actionKey: parsed.data.actionKey }];
  let worst = 0;
  for (const step of steps) {
    const provider = await deps.providers.getByKey(organizationId, step.providerKey);
    if (!provider || !provider.enabled) throw new ValidationError(`Connect and enable the "${step.providerKey}" provider before running “${column.name}”.`);
    const adapter = deps.adapters.adapterFor(provider);
    const action = adapter?.actions(provider).find((a) => a.key === step.actionKey);
    if (!adapter || !action) throw new ValidationError(`“${column.name}” uses an action that provider "${step.providerKey}" does not offer.`);
    const needsKey = catalogEntry(adapter.adapter)?.credentialFields.some((f) => f.required);
    if (needsKey && !provider.hasCredential) throw new ValidationError(`Add the API key for "${step.providerKey}" before running “${column.name}”.`);
    worst += estimateStepCents(provider, action);
  }
  const cap = "maxCostCents" in parsed.data ? parsed.data.maxCostCents : undefined;
  return cap === undefined ? worst : Math.min(worst, cap);
}

/** Worst-case cents of one cell of this column. A column that would fail before calling anyone costs nothing. */
export async function cellCents(deps: CostDeps, organizationId: string, column: ColumnRow): Promise<number> {
  try {
    return await preflight(deps, organizationId, column);
  } catch (error) {
    if (error instanceof ValidationError) return 0;
    throw error;
  }
}

/** Worst-case cents per runnable column that reads one of `writtenKeys`, for the finishing write's own cascade. */
export async function cascadeSpecFor(deps: CostDeps, organizationId: string, columns: readonly ColumnRow[], writtenKeys: readonly string[]): Promise<CascadeSpec> {
  const centsByColumn: Record<string, number> = {};
  for (const column of columns) {
    if (!column.autoRun || !RUNNABLE_TYPES.has(column.type) || !column.dependsOn.some((d) => writtenKeys.includes(d))) continue;
    centsByColumn[column.key] = await cellCents(deps, organizationId, column);
  }
  return { centsByColumn };
}
