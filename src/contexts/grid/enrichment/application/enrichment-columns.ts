import { NotFoundError, ValidationError, type Actor } from "@/shared/errors";
import { aiConfigSchema, enrichmentConfigSchema, waterfallConfigSchema, type AiConfig } from "../domain/enrichment-config";
import { tokensIn } from "../domain/enrichment-templates";
import { chainPlacement } from "../../domain/column-layout";
import { normalizeKey, uniqueColumnKey, uniqueColumnName } from "../../domain/keys";
import type { ActionSpec } from "../domain/enrichment-catalog";
import type { VerificationStatus } from "../domain/enrichment-contracts";
import { acceptsText, inputsCovered } from "../domain/enrichment-inputs";
import type { AdapterRegistry, ColumnChange, ColumnRow, GridRunStore, NewColumn, ProviderStore } from "./enrichment-ports";

export interface ColumnDeps {
  store: GridRunStore;
  providers: ProviderStore;
  adapters: AdapterRegistry;
}

interface Placement {
  afterColumnId?: string;
}

const outputColumn = (plan: ReturnType<typeof planChain>, mainKey: string, r: ReturnType<typeof planChain>["outputRows"][number], i: number, type: string, valueType: string): NewColumn => ({
  key: r.key,
  name: r.name,
  type,
  config: { sourceColumnKey: mainKey, outputKey: r.o.outputKey, valueType },
  dependsOn: [mainKey],
  position: plan.positions[i + 1],
  autoRun: false,
});

/** The action a step runs. A new column needs its provider on; an edit only needs it connected, so a paused column stays editable. */
async function loadAction(deps: ColumnDeps, organizationId: string, providerKey: string, actionKey: string, options: { allowOff?: boolean } = {}): Promise<ActionSpec> {
  const provider = await deps.providers.getByKey(organizationId, providerKey);
  if (!provider || (!provider.enabled && !options.allowOff)) throw new ValidationError(`Provider "${providerKey}" is not connected or is switched off.`);
  const action = deps.adapters.adapterFor(provider)?.actions(provider).find((a) => a.key === actionKey);
  if (!action) throw new ValidationError(`Provider "${providerKey}" has no action "${actionKey}".`);
  return action;
}

function checkInputColumns(existing: ColumnRow[], inputs: Record<string, string>) {
  const keys = new Set(existing.map((c) => c.key));
  for (const [input, column] of Object.entries(inputs)) {
    if (!keys.has(column)) throw new ValidationError(`Input "${input}" points at a column that does not exist.`);
  }
}

type OutputSpec = { label: string; outputKey: string; valueType: string; type: "integration_output" | "ai_output" };

/**
 * Keys, names and positions for a main column and its output columns. Runs inside the table lock with the columns
 * as they are at that moment, so a renumber by another write cannot leave these positions stale.
 */
function planChain(existing: ColumnRow[], main: { label: string }, outputs: OutputSpec[], afterColumnId?: string) {
  const taken = new Set(existing.map((c) => c.key));
  const names = existing.map((c) => c.name);
  const mainName = uniqueColumnName(main.label, names);
  names.push(mainName);
  const mainKey = uniqueColumnKey(main.label, taken);
  taken.add(mainKey);
  const placement = chainPlacement(existing, outputs.length + 1, afterColumnId);
  const outputRows = outputs.map((o) => {
    const key = uniqueColumnKey(o.label, taken);
    taken.add(key);
    const name = uniqueColumnName(o.label, names);
    names.push(name);
    return { key, name, o };
  });
  return { mainKey, mainName, positions: placement.positions, renumber: placement.renumber, outputRows };
}

async function writeChange(deps: ColumnDeps, organizationId: string, tableId: string, plan: (columns: ColumnRow[], hasValues: (key: string) => Promise<boolean>) => Promise<ColumnChange> | ColumnChange) {
  const result = await deps.store.changeColumns(organizationId, tableId, ({ columns, hasValues }) => plan(columns, hasValues));
  if (!result) throw new NotFoundError("Table not found");
  return result;
}

export interface CreateEnrichmentInput extends Placement {
  providerKey: string;
  actionKey: string;
  inputs: Record<string, string>;
  selectedOutputs: string[];
  autoRun?: boolean;
  delaySeconds?: number;
  reuseDays?: number;
  settledStatuses?: VerificationStatus[];
}

/** Refuses a mapping that misses a required input or every combination the action accepts. `step` is 0-based. */
function requireMapped(action: ActionSpec, mapped: Record<string, string>, step?: number): void {
  for (const spec of action.inputs) {
    if (spec.required && !mapped[spec.key]) throw new ValidationError(step === undefined ? `Map the "${spec.name}" input to a column.` : `Step ${step + 1} (${action.name}) needs the "${spec.name}" input mapped.`);
  }
  if (!inputsCovered(action, (key) => !!mapped[key])) {
    throw new ValidationError(step === undefined ? `Map ${acceptsText(action)} to columns.` : `Step ${step + 1} (${action.name}) needs ${acceptsText(action)} mapped.`);
  }
}

export async function createEnrichmentColumns(deps: ColumnDeps, actor: Actor, tableId: string, input: CreateEnrichmentInput): Promise<ColumnRow[]> {
  const action = await loadAction(deps, actor.organizationId, input.providerKey, input.actionKey);
  const selected = action.outputs.filter((o) => input.selectedOutputs.includes(o.key));
  if (selected.length === 0 || selected.length !== new Set(input.selectedOutputs).size) throw new ValidationError("Select at least one valid output.");
  requireMapped(action, input.inputs);
  const unknown = Object.keys(input.inputs).find((k) => !action.inputs.some((i) => i.key === k));
  if (unknown) throw new ValidationError(`"${unknown}" is not an input of this action.`);

  const outputs = selected.map((o) => ({ label: o.name, outputKey: o.key, valueType: o.type, type: "integration_output" as const }));
  const result = await writeChange(deps, actor.organizationId, tableId, (columns) => {
    const plan = planChain(columns, { label: action.name }, outputs, input.afterColumnId);
    checkInputColumns(columns, input.inputs);
    const config = enrichmentConfigSchema.parse({
      providerKey: input.providerKey,
      actionKey: input.actionKey,
      inputs: input.inputs,
      outputs: Object.fromEntries(plan.outputRows.map((r) => [r.o.outputKey, r.key])),
      delaySeconds: input.delaySeconds,
      reuseDays: input.reuseDays,
      settledStatuses: input.settledStatuses,
    });
    return {
      renumber: plan.renumber,
      inserts: [
        { key: plan.mainKey, name: plan.mainName, type: "enrichment", config, dependsOn: [...new Set(Object.values(input.inputs))], position: plan.positions[0], autoRun: input.autoRun ?? true },
        ...plan.outputRows.map((r, i) => outputColumn(plan, plan.mainKey, r, i, "integration_output", r.o.valueType)),
      ],
    };
  });
  return result.inserted;
}

export interface CreateWaterfallInput extends Placement {
  name?: string;
  /** Logical input key (as named by the actions) to the column that feeds it. */
  inputs: Record<string, string>;
  steps: Array<{ providerKey: string; actionKey: string }>;
  selectedOutputs: string[];
  maxCostCents?: number;
  maxCredits?: number;
  onRateLimit?: "next" | "wait";
  reuseDays?: number;
  settledStatuses?: VerificationStatus[];
  autoRun?: boolean;
  delaySeconds?: number;
}

export async function createWaterfallColumns(deps: ColumnDeps, actor: Actor, tableId: string, input: CreateWaterfallInput): Promise<ColumnRow[]> {
  if (input.steps.length === 0 || input.steps.length > 8) throw new ValidationError("A waterfall needs 1 to 8 steps.");
  const actions: ActionSpec[] = [];
  for (const step of input.steps) actions.push(await loadAction(deps, actor.organizationId, step.providerKey, step.actionKey));
  // Every step must offer each output the waterfall exposes, and each input it needs must be mapped.
  const first = actions[0];
  const selected = first.outputs.filter((o) => input.selectedOutputs.includes(o.key));
  if (selected.length === 0 || selected.length !== new Set(input.selectedOutputs).size) throw new ValidationError("Select at least one valid output.");
  for (const [i, action] of actions.entries()) {
    for (const o of selected) if (!action.outputs.some((x) => x.key === o.key)) throw new ValidationError(`Step ${i + 1} (${action.name}) has no "${o.key}" output.`);
    requireMapped(action, input.inputs, i);
  }

  const label = input.name?.trim() || `Waterfall ${first.name}`;
  const outputs = selected.map((o) => ({ label: o.name, outputKey: o.key, valueType: o.type, type: "integration_output" as const }));
  const result = await writeChange(deps, actor.organizationId, tableId, (columns) => {
    const plan = planChain(columns, { label }, outputs, input.afterColumnId);
    checkInputColumns(columns, input.inputs);
    const config = waterfallConfigSchema.parse({
      inputs: input.inputs,
      steps: input.steps,
      outputs: Object.fromEntries(plan.outputRows.map((r) => [r.o.outputKey, r.key])),
      maxCostCents: input.maxCostCents,
      maxCredits: input.maxCredits,
      onRateLimit: input.onRateLimit,
      reuseDays: input.reuseDays,
      settledStatuses: input.settledStatuses,
      delaySeconds: input.delaySeconds,
    });
    return {
      renumber: plan.renumber,
      inserts: [
        { key: plan.mainKey, name: plan.mainName, type: "waterfall", config, dependsOn: [...new Set(Object.values(input.inputs))], position: plan.positions[0], autoRun: input.autoRun ?? true },
        ...plan.outputRows.map((r, i) => outputColumn(plan, plan.mainKey, r, i, "integration_output", r.o.valueType)),
      ],
    };
  });
  return result.inserted;
}

export type AiOutputType = AiConfig["outputs"][number]["type"];

export interface AiOutputInput {
  key: string;
  type: AiOutputType;
  description?: string;
}

export interface CreateAiInput extends Placement {
  name?: string;
  prompt: string;
  outputs: AiOutputInput[];
  autoRun?: boolean;
  delaySeconds?: number;
}

export async function createAiColumns(deps: ColumnDeps, actor: Actor, tableId: string, input: CreateAiInput): Promise<ColumnRow[]> {
  const label = input.name?.trim() || "AI";
  if (new Set(input.outputs.map((o) => o.key)).size !== input.outputs.length) throw new ValidationError("Output field keys must be unique.");
  const referenced = tokensIn(input.prompt);
  const outputs = input.outputs.map((o) => ({ label: o.key, outputKey: o.key, valueType: o.type, type: "ai_output" as const }));
  const result = await writeChange(deps, actor.organizationId, tableId, (columns) => {
    const plan = planChain(columns, { label }, outputs, input.afterColumnId);
    const known = new Set(columns.map((c) => c.key));
    const missing = referenced.find((k) => !known.has(k));
    if (missing) throw new ValidationError(`The prompt mentions {{${missing}}}, which is not a column of this table.`);
    const parsed = aiConfigSchema.safeParse({
      prompt: input.prompt,
      outputs: input.outputs,
      outputColumns: Object.fromEntries(plan.outputRows.map((r) => [r.o.outputKey, r.key])),
      delaySeconds: input.delaySeconds,
    });
    if (!parsed.success) throw new ValidationError(aiConfigProblem(parsed.error.issues));
    return {
      renumber: plan.renumber,
      inserts: [
        { key: plan.mainKey, name: plan.mainName, type: "ai", config: parsed.data, dependsOn: referenced, position: plan.positions[0], autoRun: input.autoRun ?? true },
        ...plan.outputRows.map((r, i) => outputColumn(plan, plan.mainKey, r, i, "ai_output", r.o.valueType)),
      ],
    };
  });
  return result.inserted;
}

const valueTypeOf = (column: ColumnRow) => (typeof column.config.valueType === "string" ? column.config.valueType : "text");

/**
 * Matches the requested output fields of an AI column with the columns it already fills: first by field key, then by
 * column name (a renamed field keeps the column its name points at). A field with no match gets a new column.
 * Fields left out stop being written; their columns and values stay.
 */
export function matchAiOutputs(
  config: AiConfig,
  columns: readonly ColumnRow[],
  requested: readonly AiOutputInput[],
): Array<{ field: AiOutputInput; column: ColumnRow | null }> {
  const owned = columns.filter((c) => c.type === "ai_output" && Object.values(config.outputColumns).includes(c.key));
  const taken = new Set<string>();
  const matches = requested.map((field) => {
    const byKey = config.outputColumns[field.key];
    const column = byKey ? owned.find((c) => c.key === byKey) : undefined;
    if (column && !taken.has(column.key)) taken.add(column.key);
    return { field, column: column && taken.has(column.key) ? column : null };
  });
  return matches.map((m) => {
    if (m.column) return m;
    const wanted = normalizeKey(m.field.key).toLowerCase();
    const byName = owned.find((c) => !taken.has(c.key) && normalizeKey(c.name).toLowerCase() === wanted);
    if (byName) taken.add(byName.key);
    return { field: m.field, column: byName ?? null };
  });
}

interface UpdateRunnableInput {
  autoRun?: boolean;
  delaySeconds?: number;
  inputs?: Record<string, string>;
  prompt?: string;
  /** AI columns: the full list of output fields. Existing columns are reused (see matchAiOutputs). */
  outputs?: AiOutputInput[];
  /** Waterfall columns: the full list of steps, 1 to 8. */
  steps?: Array<{ providerKey: string; actionKey: string }>;
  /** Waterfall columns: the caps and the rate-limit choice. Null removes a cap. */
  maxCostCents?: number | null;
  maxCredits?: number | null;
  onRateLimit?: "next" | "wait";
  /** Enrichment and waterfall columns: days to reuse an answer, and the verdicts that end a verification (null: the default). */
  reuseDays?: number;
  settledStatuses?: VerificationStatus[] | null;
}

/** Re-saves the settings of an existing runnable column, in one locked write with any output columns it adds or retypes. */
export async function updateRunnableColumn(deps: ColumnDeps, actor: Actor, tableId: string, columnId: string, input: UpdateRunnableInput): Promise<ColumnRow> {
  const org = actor.organizationId;
  // Provider lookups are network-free store reads; do them before the lock.
  const stepActions: ActionSpec[] = [];
  for (const step of input.steps ?? []) stepActions.push(await loadAction(deps, org, step.providerKey, step.actionKey, { allowOff: true }));
  // An inputs edit is checked against the actions the column runs now (or the new steps), as create does.
  let inputActions: ActionSpec[] = stepActions;
  if (input.inputs !== undefined && input.steps === undefined) {
    const current = (await deps.store.listColumns(org, tableId)).find((c) => c.id === columnId);
    if (current?.type === "enrichment") {
      const { providerKey, actionKey } = current.config as { providerKey?: string; actionKey?: string };
      inputActions = providerKey && actionKey ? [await loadAction(deps, org, providerKey, actionKey, { allowOff: true })] : [];
    } else if (current?.type === "waterfall") {
      const steps = ((current.config as { steps?: Array<{ providerKey: string; actionKey: string }> }).steps ?? []);
      inputActions = [];
      for (const step of steps) inputActions.push(await loadAction(deps, org, step.providerKey, step.actionKey, { allowOff: true }));
    }
  }

  const result = await writeChange(deps, org, tableId, async (columns, hasValues) => {
    const column = columns.find((c) => c.id === columnId);
    if (!column || !["enrichment", "waterfall", "ai"].includes(column.type)) throw new NotFoundError("Column not found");
    const own = new Set([column.key, ...columns.filter((c) => c.config.sourceColumnKey === column.key).map((c) => c.key)]);
    const config = { ...column.config } as Record<string, unknown>;
    let dependsOn = column.dependsOn;
    const change: ColumnChange = { inserts: [], updates: [] };
    if (input.delaySeconds !== undefined) config.delaySeconds = input.delaySeconds;
    const waterfallOnly = input.maxCostCents !== undefined || input.maxCredits !== undefined || input.onRateLimit !== undefined;
    if (waterfallOnly && column.type !== "waterfall") throw new ValidationError("Only waterfall columns have caps and a rate-limit choice.");
    if ((input.reuseDays !== undefined || input.settledStatuses !== undefined) && column.type === "ai") throw new ValidationError("AI columns do not reuse answers or settle verdicts.");
    const setOrClear = (key: string, value: unknown) => {
      if (value === undefined) return;
      if (value === null) delete config[key];
      else config[key] = value;
    };
    setOrClear("maxCostCents", input.maxCostCents);
    setOrClear("maxCredits", input.maxCredits);
    setOrClear("onRateLimit", input.onRateLimit);
    setOrClear("reuseDays", input.reuseDays);
    setOrClear("settledStatuses", input.settledStatuses);
    if (column.type === "ai") {
      if (input.inputs !== undefined) throw new ValidationError("AI columns read their columns from the prompt, so they have no inputs to edit.");
      if (input.steps !== undefined) throw new ValidationError("Only waterfall columns have steps.");
      if (input.prompt !== undefined) config.prompt = input.prompt.trim();
      dependsOn = tokensIn(String(config.prompt ?? ""));
      const known = new Set(columns.map((c) => c.key));
      const missing = dependsOn.find((k) => !known.has(k));
      if (missing) throw new ValidationError(`The prompt mentions {{${missing}}}, which is not a column of this table.`);
      const current = aiConfigSchema.safeParse(config);
      if (!current.success) throw new ValidationError(aiConfigProblem(current.error.issues));
      if (input.outputs) await editAiOutputs(columns, column, current.data, input.outputs, config, change, hasValues);
      const parsed = aiConfigSchema.safeParse(config);
      if (!parsed.success) throw new ValidationError(aiConfigProblem(parsed.error.issues));
    } else {
      if (input.outputs) throw new ValidationError("Only AI columns have output fields to edit.");
      if (input.prompt !== undefined) throw new ValidationError("Only AI columns have a prompt.");
      if (input.inputs) {
        checkInputColumns(columns, input.inputs);
        for (const action of inputActions) {
          requireMapped(action, input.inputs);
        }
        config.inputs = input.inputs;
      }
      if (input.steps) {
        if (column.type !== "waterfall") throw new ValidationError("Only waterfall columns have steps.");
        if (input.steps.length === 0 || input.steps.length > 8) throw new ValidationError("A waterfall needs 1 to 8 steps.");
        const exposed = Object.keys((config.outputs ?? {}) as Record<string, string>);
        const mapped = (config.inputs ?? {}) as Record<string, string>;
        for (const [i, action] of stepActions.entries()) {
          for (const key of exposed) if (!action.outputs.some((o) => o.key === key)) throw new ValidationError(`Step ${i + 1} (${action.name}) has no "${key}" output.`);
          requireMapped(action, mapped, i);
        }
        config.steps = input.steps;
      }
      dependsOn = [...new Set(Object.values((config.inputs ?? {}) as Record<string, string>))];
      const parsed = (column.type === "enrichment" ? enrichmentConfigSchema : waterfallConfigSchema).safeParse(config);
      if (!parsed.success) throw new ValidationError("The column settings are not valid. Check each field and try again.");
    }
    // An input mapped to this column's own output would feed the run its own result and queue it forever.
    const loop = dependsOn.find((k) => own.has(k));
    if (loop) throw new ValidationError("A column cannot read its own output.");
    change.updates!.push({ id: column.id, config, dependsOn, autoRun: input.autoRun });
    return change;
  });
  return result.updated.find((c) => c.id === columnId)!;
}

/** What to tell a person whose AI column settings failed the schema: the field in plain words, not the schema path. */
export function aiConfigProblem(issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey> }>): string {
  const reasons = new Set<string>();
  for (const issue of issues) {
    const [head, index, leaf] = issue.path;
    if (head === "prompt") reasons.add("The prompt must be 1 to 8,000 characters.");
    else if (head === "outputs" && typeof index === "number" && leaf === "key") reasons.add(`Output field ${index + 1}: the key must start with a lowercase letter and use only letters, numbers and underscores, up to 40 characters.`);
    else if (head === "outputs" && typeof index === "number" && leaf === "type") reasons.add(`Output field ${index + 1}: pick a type from the list.`);
    else if (head === "outputs" && typeof index === "number" && leaf === "description") reasons.add(`Output field ${index + 1}: the description must be 300 characters or fewer.`);
    else if (head === "outputs") reasons.add("An AI column needs 1 to 12 output fields.");
    else if (head === "delaySeconds") reasons.add("The delay must be a whole number of seconds from 0 to 3,600.");
  }
  return reasons.size > 0 ? [...reasons].join(" ") : "The AI column settings are not valid. Check each field and try again.";
}

/** Applies a new output list to an AI config: reuses columns, refuses a retype over values, and plans the new columns. */
async function editAiOutputs(columns: ColumnRow[], column: ColumnRow, current: AiConfig, requested: AiOutputInput[], config: Record<string, unknown>, change: ColumnChange, hasValues: (key: string) => Promise<boolean>) {
  if (requested.length === 0) throw new ValidationError("An AI column needs at least one output field.");
  if (new Set(requested.map((o) => o.key)).size !== requested.length) throw new ValidationError("Output field keys must be unique.");
  const matches = matchAiOutputs(current, columns, requested);
  const outputColumns: Record<string, string> = {};
  const fresh: Array<{ field: AiOutputInput }> = [];
  for (const { field, column: reused } of matches) {
    if (!reused) {
      fresh.push({ field });
      continue;
    }
    outputColumns[field.key] = reused.key;
    if (valueTypeOf(reused) !== field.type) {
      if (await hasValues(reused.key)) {
        throw new ValidationError(`"${reused.name}" already has values, so it cannot change from ${valueTypeOf(reused)} to ${field.type}. Clear its values first, or add a new field with the type you want.`);
      }
      change.updates!.push({ id: reused.id, config: { ...reused.config, valueType: field.type } });
    }
  }
  // New columns sit after the last column this AI column already fills, or after the AI column itself.
  const filled = columns.filter((c) => Object.values(current.outputColumns).includes(c.key));
  const anchor = [column, ...filled].sort((a, b) => b.position - a.position)[0];
  const taken = new Set(columns.map((c) => c.key));
  const names = columns.map((c) => c.name);
  const placement = chainPlacement(columns, fresh.length, anchor.id);
  change.renumber = placement.renumber;
  fresh.forEach(({ field }, i) => {
    const key = uniqueColumnKey(field.key, taken);
    taken.add(key);
    const name = uniqueColumnName(field.key, names);
    names.push(name);
    outputColumns[field.key] = key;
    change.inserts.push({ key, name, type: "ai_output", config: { sourceColumnKey: column.key, outputKey: field.key, valueType: field.type }, dependsOn: [column.key], position: placement.positions[i], autoRun: false });
  });
  config.outputs = requested.map((o) => ({ key: o.key, type: o.type, ...(o.description?.trim() ? { description: o.description.trim() } : {}) }));
  config.outputColumns = outputColumns;
}
