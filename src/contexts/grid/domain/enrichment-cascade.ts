import { CONTRACTS, type ContractKey } from "./enrichment-contracts";
import { inputsCovered } from "./enrichment-inputs";
import { hasCellValue, ownCell, tokensIn } from "./enrichment-templates";

/** What a cascade needs of a column. */
export interface CascadeColumn {
  key: string;
  type: string;
  config: Record<string, unknown>;
  dependsOn: string[];
  autoRun: boolean;
}

export const RUNNABLE_TYPES: ReadonlySet<string> = new Set(["enrichment", "waterfall", "ai"]);

/** Column keys a runnable column reads from its row. */
export function inputColumns(column: Pick<CascadeColumn, "type" | "config">): string[] {
  const config = column.config;
  if (column.type === "ai") return tokensIn(typeof config.prompt === "string" ? config.prompt : "");
  const inputs = config.inputs;
  if (inputs && typeof inputs === "object") return [...new Set(Object.values(inputs as Record<string, unknown>).filter((v): v is string => typeof v === "string"))];
  return [];
}

/** The shared contracts of a column's steps, or null when a step runs an action outside them. */
function contractsOf(config: Record<string, unknown>) {
  const steps = Array.isArray(config.steps) ? (config.steps as { actionKey?: unknown }[]) : [config];
  const contracts = steps.map((step) => (typeof step.actionKey === "string" && step.actionKey in CONTRACTS ? CONTRACTS[step.actionKey as ContractKey] : null));
  return contracts.every((contract) => contract) ? (contracts as (typeof CONTRACTS)[ContractKey][]) : null;
}

/**
 * Whether a column has anything to work with. An enrichment or waterfall on a shared contract runs once the row fills
 * the contract's required inputs and one combination it accepts (enrich-person matches on an email, a LinkedIn URL, or
 * a name with a company); any other action needs every mapped input. An AI column runs when at least one referenced
 * cell has a value, because a prompt may mention optional columns.
 */
export function inputsReady(column: Pick<CascadeColumn, "type" | "config">, cells: Record<string, unknown>): boolean {
  const keys = inputColumns(column);
  if (column.type === "ai") return keys.length === 0 || keys.some((k) => hasCellValue(ownCell(cells, k)));
  const mapped = Object.fromEntries(Object.entries((column.config.inputs ?? {}) as Record<string, unknown>).filter(([, v]) => typeof v === "string")) as Record<string, string>;
  const filled = (inputKey: string) => inputKey in mapped && hasCellValue(ownCell(cells, mapped[inputKey]));
  if (keys.length === 0 || !Object.keys(mapped).some(filled)) return false;
  const contracts = contractsOf(column.config);
  return contracts ? contracts.some((contract) => inputsCovered(contract, filled)) : Object.keys(mapped).every(filled);
}

/** Columns to queue after `changedKeys` got new values in a row: auto-run, reading a changed key, inputs ready. */
export function cascadeTargets(columns: readonly CascadeColumn[], cells: Record<string, unknown>, changedKeys: readonly string[]): CascadeColumn[] {
  return columns.filter(
    (c) => c.autoRun && RUNNABLE_TYPES.has(c.type) && c.dependsOn.some((d) => changedKeys.includes(d)) && inputsReady(c, cells),
  );
}

/**
 * Auto-run columns that fill after `keys` do, directly or through other auto-run columns: they read one of those
 * columns or one of their output columns. Used to count what a run sets off, not only what it queues.
 */
export function autoRunDescendants(columns: readonly CascadeColumn[], keys: readonly string[]): CascadeColumn[] {
  const ownerOf = new Map<string, string>();
  for (const c of columns) {
    const source = (c.config as { sourceColumnKey?: unknown }).sourceColumnKey;
    if ((c.type === "integration_output" || c.type === "ai_output") && typeof source === "string") ownerOf.set(c.key, source);
  }
  const done = new Set(keys);
  const found: CascadeColumn[] = [];
  for (let grew = true; grew; ) {
    grew = false;
    for (const c of columns) {
      if (done.has(c.key) || !c.autoRun || !RUNNABLE_TYPES.has(c.type)) continue;
      if (!c.dependsOn.some((d) => done.has(ownerOf.get(d) ?? d))) continue;
      done.add(c.key);
      found.push(c);
      grew = true;
    }
  }
  return found;
}

/** Roots of the run graph: runnable columns that do not read another runnable column's output. */
export function runRoots(columns: readonly (CascadeColumn & { id?: string })[]): CascadeColumn[] {
  const runnable = columns.filter((c) => RUNNABLE_TYPES.has(c.type));
  const outputOwner = new Map<string, string>();
  for (const c of columns) {
    const source = (c.config as { sourceColumnKey?: unknown }).sourceColumnKey;
    if ((c.type === "integration_output" || c.type === "ai_output") && typeof source === "string") outputOwner.set(c.key, source);
  }
  const running = new Set(runnable.map((c) => c.key));
  return runnable.filter((c) => !c.dependsOn.some((d) => running.has(outputOwner.get(d) ?? d) && (outputOwner.get(d) ?? d) !== c.key));
}
