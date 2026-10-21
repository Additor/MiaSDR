import { hasCellValue } from "./enrichment-templates";

/**
 * Waterfall semantics: steps run in order and the first hit wins. A miss moves on. A permanent error
 * (bad key, rejected request) is recorded and moves on. A transient error or a rate-limited provider moves
 * on too, but if nothing hits the cell is retried later, and the steps that already answered with a miss
 * are not asked again. A retry carries the first miss verdict and the cents spent, so a paid answer and the cost cap
 * survive it. Every attempt is returned so the caller can write one ledger row per attempt.
 */

export interface WaterfallStep {
  providerKey: string;
  actionKey: string;
}

export const stepId = (step: WaterfallStep) => `${step.providerKey}/${step.actionKey}`;

export type StepExecution =
  | { kind: "result"; outcome: "hit" | "miss"; primary: unknown; outputs: Record<string, unknown>; costCents: number; credits?: number | null; latencyMs?: number; request?: unknown; response?: unknown }
  | { kind: "error"; transient: boolean; message: string; costCents?: number; request?: unknown; response?: unknown; retryAfterMs?: number }
  | { kind: "rate_limited"; retryAfterMs: number }
  | { kind: "unavailable"; message: string };

export interface StepAttempt {
  step: WaterfallStep;
  outcome: "hit" | "miss" | "error" | "skipped";
  costCents: number;
  /** Vendor credits the call used, or null when the provider has no credits. */
  credits?: number | null;
  latencyMs?: number;
  request?: unknown;
  response?: unknown;
  /** Why the attempt did not produce an answer. */
  detail?: string;
  /** True for an error worth retrying, a rate limit, or a skip caused by the cost cap. */
  retryable?: boolean;
}

export type WaterfallResult =
  | ({ status: "hit"; winner: Extract<StepExecution, { kind: "result" }>; winnerStep: WaterfallStep } & Spent)
  | ({ status: "miss"; fallback?: MissVerdict } & Spent)
  | ({ status: "retry"; retryAfterMs?: number; fallback?: MissVerdict } & Spent)
  | ({ status: "failed"; message: string } & Spent);

/** What a cell has spent so far, earlier tries included, and the steps that missed. */
interface Spent {
  attempts: StepAttempt[];
  spentCents: number;
  spentCredits: number;
  missed: string[];
}

/** A miss that still carried a verdict, such as a catch-all address. The first one in step order is kept. */
export interface MissVerdict {
  step: WaterfallStep;
  primary: unknown;
  outputs: Record<string, unknown>;
}

export interface WaterfallOptions {
  /** Cents this cell may spend in total. A step whose worst case would pass it is skipped. */
  maxCostCents?: number;
  /** Cents a step can cost at most, checked against `maxCostCents` before the call. */
  estimate: (step: WaterfallStep) => number;
  /** Vendor credits one cell may use. A step whose credits would pass it is skipped. */
  maxCredits?: number;
  /** Credits a step uses at most, checked against `maxCredits`. */
  estimateCredits?: (step: WaterfallStep) => number;
  /** Steps that answered with a miss on an earlier try of this cell. */
  alreadyMissed?: ReadonlySet<string>;
  /** The miss verdict an earlier try of this cell kept. */
  carriedFallback?: MissVerdict;
  /** Cents earlier tries of this cell spent, counted against `maxCostCents`. */
  carriedSpentCents?: number;
  /** Credits earlier tries of this cell used, counted against `maxCredits`. */
  carriedSpentCredits?: number;
  /** Stops early (cancel, deadline). */
  shouldStop?: () => boolean;
  /**
   * True stops at a rate-limited step (the gate or the vendor's 429) and retries the cell later, so a later and maybe
   * pricier step is not asked while the preferred one only needs a moment.
   */
  waitOnRateLimit?: boolean;
}

export async function runWaterfall(
  steps: readonly WaterfallStep[],
  execute: (step: WaterfallStep) => Promise<StepExecution>,
  options: WaterfallOptions,
): Promise<WaterfallResult> {
  const attempts: StepAttempt[] = [];
  const missed = new Set(options.alreadyMissed ?? []);
  let spent = options.carriedSpentCents ?? 0;
  let credits = options.carriedSpentCredits ?? 0;
  let transient = false;
  let limitedAfterMs: number | undefined;
  let permanentMessage: string | null = null;
  let answered = false;
  let fallback: MissVerdict | undefined = options.carriedFallback;

  for (const step of steps) {
    if (options.shouldStop?.()) {
      transient = true;
      break;
    }
    const id = stepId(step);
    if (missed.has(id)) {
      answered = true;
      continue;
    }
    if (options.maxCostCents !== undefined && spent + options.estimate(step) > options.maxCostCents) {
      attempts.push({ step, outcome: "skipped", costCents: 0, detail: "The per-cell cost cap would be exceeded." });
      continue;
    }
    if (options.maxCredits !== undefined && credits + (options.estimateCredits?.(step) ?? 0) > options.maxCredits) {
      attempts.push({ step, outcome: "skipped", costCents: 0, detail: "The per-cell credit cap would be exceeded." });
      continue;
    }
    const result = await execute(step);
    if (result.kind === "result") {
      spent += result.costCents;
      credits += result.credits ?? 0;
      attempts.push({ step, outcome: result.outcome, costCents: result.costCents, credits: result.credits, latencyMs: result.latencyMs, request: result.request, response: result.response });
      if (result.outcome === "hit") {
        return { status: "hit", winner: result, winnerStep: step, attempts, spentCents: spent, spentCredits: credits, missed: [...missed] };
      }
      if (!fallback && hasCellValue(result.primary)) fallback = { step, primary: result.primary, outputs: result.outputs };
      missed.add(id);
      answered = true;
    } else if (result.kind === "error") {
      spent += result.costCents ?? 0;
      attempts.push({ step, outcome: "error", costCents: result.costCents ?? 0, detail: result.message, request: result.request, response: result.response, retryable: result.transient });
      if (result.transient) {
        transient = true;
        if (result.retryAfterMs !== undefined) limitedAfterMs = Math.min(limitedAfterMs ?? Infinity, result.retryAfterMs);
        if (result.retryAfterMs !== undefined && options.waitOnRateLimit) break;
      } else permanentMessage ??= result.message;
    } else if (result.kind === "rate_limited") {
      attempts.push({ step, outcome: "skipped", costCents: 0, detail: "The provider's rate limit is used up for now.", retryable: true });
      limitedAfterMs = Math.min(limitedAfterMs ?? Infinity, result.retryAfterMs);
      if (options.waitOnRateLimit) break;
    } else {
      attempts.push({ step, outcome: "skipped", costCents: 0, detail: result.message });
      permanentMessage ??= result.message;
    }
  }

  const base = { attempts, spentCents: spent, spentCredits: credits, missed: [...missed] };
  if (transient || limitedAfterMs !== undefined) return { status: "retry", retryAfterMs: limitedAfterMs, ...(fallback ? { fallback } : {}), ...base };
  if (!answered && permanentMessage !== null) return { status: "failed", message: permanentMessage, ...base };
  return { status: "miss", ...(fallback ? { fallback } : {}), ...base };
}
