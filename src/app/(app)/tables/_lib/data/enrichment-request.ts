import { DEFAULT_REUSE_DAYS } from "@/contexts/grid/enrichment/domain/enrichment-config";
import { SETTLED_STATUSES } from "@/contexts/grid/enrichment/domain/enrichment-contracts";
import { centsToDollarsText, creditCap, dollarsToCents, toRunSettingsBody } from "./run-request";
import type { WaterfallStep } from "./waterfall-steps";

/** The bodies the enrichment dialog sends, apart from React so the rules on what a column may spend can be tested. */

export const SPEND_CAP_ERROR = "Enter the spend cap as zero or more dollars, or leave it empty.";

/** Text that is no cap: dollars below zero or not a number. Empty means no cap, and a $0 cap must be typed. */
export const spendCapInvalid = (text: string) => text.trim() !== "" && dollarsToCents(text) === null;

export const CREDIT_CAP_ERROR = "Enter the credit cap as zero or more credits, or leave it empty.";

/** Text that is no cap: credits below zero or not a number. `creditCap` reads it as 0, which stops every call. */
export const creditCapInvalid = (text: string) => text.trim() !== "" && !(Number(text) >= 0);

const usedInputs = (inputs: Record<string, string>) => Object.fromEntries(Object.entries(inputs).filter(([, v]) => v));

const catchAllStops = () => [...SETTLED_STATUSES, "catch_all"];

export interface EnrichmentCreateInput {
  /** Left out for an action outside the shared outcomes: the server names the column. */
  name?: string;
  steps: WaterfallStep[];
  inputs: Record<string, string>;
  selectedOutputs: string[];
  afterColumnId?: string;
  autoRun: boolean;
  delay: string;
  reuseDays: string;
  stopAtCatchAll?: boolean;
  maxCost?: string;
  maxCredits?: string;
  waitOnLimit?: boolean;
}

/** The body that adds a column: one provider, or several tried in order as a waterfall, which alone takes caps. */
export function toCreateBody(input: EnrichmentCreateInput): Record<string, unknown> {
  const { name, steps, stopAtCatchAll, maxCost = "", maxCredits = "", waitOnLimit } = input;
  const base = {
    ...(name !== undefined ? { name } : {}),
    inputs: usedInputs(input.inputs),
    selectedOutputs: input.selectedOutputs,
    afterColumnId: input.afterColumnId,
    autoRun: input.autoRun,
    ...toRunSettingsBody(input),
  };
  if (steps.length < 2) return { kind: "enrichment", providerKey: steps[0]?.providerKey, actionKey: steps[0]?.actionKey, ...base };
  const cents = dollarsToCents(maxCost);
  const credits = creditCap(maxCredits);
  return {
    kind: "waterfall",
    steps,
    ...base,
    ...(stopAtCatchAll && steps[0].actionKey === "verify-email" ? { settledStatuses: catchAllStops() } : {}),
    ...(maxCost.trim() !== "" && cents !== null ? { maxCostCents: cents } : {}),
    ...(credits !== null && !creditCapInvalid(maxCredits) ? { maxCredits: credits } : {}),
    ...(waitOnLimit ? { onRateLimit: "wait" } : {}),
  };
}

export interface EnrichmentEditValues {
  inputs: Record<string, string>;
  autoRun: boolean;
  delay: string;
  reuseDays: string;
  stopAtCatchAll: boolean;
  maxCost: string;
  maxCredits: string;
  waitOnLimit: boolean;
}

/** The edit form's starting values, from a saved column. */
export function editFormOf(column: { autoRun: boolean; config: Record<string, unknown> }): EnrichmentEditValues {
  const config = column.config as {
    inputs?: Record<string, string>;
    delaySeconds?: number;
    reuseDays?: number;
    settledStatuses?: string[];
    maxCostCents?: number;
    maxCredits?: number;
    onRateLimit?: "next" | "wait";
  };
  return {
    inputs: config.inputs ?? {},
    autoRun: column.autoRun,
    delay: String(config.delaySeconds ?? 0),
    reuseDays: String(config.reuseDays ?? DEFAULT_REUSE_DAYS),
    stopAtCatchAll: config.settledStatuses?.includes("catch_all") ?? false,
    maxCost: config.maxCostCents === undefined ? "" : centsToDollarsText(config.maxCostCents),
    maxCredits: config.maxCredits === undefined ? "" : String(config.maxCredits),
    waitOnLimit: config.onRateLimit === "wait",
  };
}

/**
 * The fields an edit changed, or the reason it cannot save. `patch` is null when nothing changed. A spend or credit cap that
 * is no amount refuses the save, so it never lands as a cap of zero that stops every call.
 */
export function toEditPatch(form: EnrichmentEditValues, initial: EnrichmentEditValues, column: { columnId: string; isWaterfall: boolean }): { patch: Record<string, unknown> | null } | { error: string } {
  const changes: Record<string, unknown> = {};
  const inputs = usedInputs(form.inputs);
  if (JSON.stringify(inputs) !== JSON.stringify(initial.inputs)) changes.inputs = inputs;
  if (form.autoRun !== initial.autoRun) changes.autoRun = form.autoRun;
  const pacing = toRunSettingsBody(form);
  if (form.delay !== initial.delay) changes.delaySeconds = pacing.delaySeconds;
  if (form.reuseDays !== initial.reuseDays) changes.reuseDays = pacing.reuseDays;
  if (form.stopAtCatchAll !== initial.stopAtCatchAll) changes.settledStatuses = form.stopAtCatchAll ? catchAllStops() : null;
  if (column.isWaterfall) {
    if (form.maxCost !== initial.maxCost) {
      if (spendCapInvalid(form.maxCost)) return { error: SPEND_CAP_ERROR };
      changes.maxCostCents = form.maxCost.trim() === "" ? null : dollarsToCents(form.maxCost);
    }
    if (form.maxCredits !== initial.maxCredits) {
      if (creditCapInvalid(form.maxCredits)) return { error: CREDIT_CAP_ERROR };
      changes.maxCredits = creditCap(form.maxCredits);
    }
    if (form.waitOnLimit !== initial.waitOnLimit) changes.onRateLimit = form.waitOnLimit ? "wait" : "next";
  }
  return { patch: Object.keys(changes).length === 0 ? null : { columnId: column.columnId, ...changes } };
}
