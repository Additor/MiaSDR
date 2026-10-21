import { CONTRACTS, type ContractKey } from "./enrichment-contracts";
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

/** The input keys a column must fill: a shared contract's required inputs, or every mapped input for any other action. */
function requiredInputs(config: Record<string, unknown>, mapped: Record<string, unknown>): string[] {
  const steps = Array.isArray(config.steps) ? (config.steps as { actionKey?: unknown }[]) : [config];
  const contracts = steps.map((step) => (typeof step.actionKey === "string" && step.actionKey in CONTRACTS ? CONTRACTS[step.actionKey as ContractKey] : null));
  if (contracts.some((contract) => !contract)) return Object.keys(mapped);
  const required = new Set(contracts.flatMap((contract) => contract!.inputs.filter((input) => input.required).map((input) => input.key)));
  return Object.keys(mapped).filter((key) => required.has(key));
}

/**
 * Whether a column has anything to work with. An enrichment or waterfall needs a value in at least one mapped input
 * and in every input its action requires; a shared contract's optional inputs (enrich-person matches on any identity)
 * may stay empty. An AI column runs when at least one referenced cell has a value, because a prompt may mention
 * optional columns.
 */
export function inputsReady(column: Pick<CascadeColumn, "type" | "config">, cells: Record<string, unknown>): boolean {
  const keys = inputColumns(column);
  if (column.type === "ai") return keys.length === 0 || keys.some((k) => hasCellValue(ownCell(cells, k)));
  const mapped = Object.fromEntries(Object.entries((column.config.inputs ?? {}) as Record<string, unknown>).filter(([, v]) => typeof v === "string")) as Record<string, string>;
  const filled = (inputKey: string) => hasCellValue(ownCell(cells, mapped[inputKey]));
  return keys.length > 0 && Object.keys(mapped).some(filled) && requiredInputs(column.config, mapped).every(filled);
}

/** Columns to queue after `changedKeys` got new values in a row: auto-run, reading a changed key, inputs ready. */
export function cascadeTargets(columns: readonly CascadeColumn[], cells: Record<string, unknown>, changedKeys: readonly string[]): CascadeColumn[] {
  return columns.filter(
    (c) => c.autoRun && RUNNABLE_TYPES.has(c.type) && c.dependsOn.some((d) => changedKeys.includes(d)) && inputsReady(c, cells),
  );
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
