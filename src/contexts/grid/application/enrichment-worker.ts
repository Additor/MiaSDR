import type { Job } from "@/platform/jobs/types";
import { MAX_JOBS_PER_TICK, clampConcurrency } from "../domain/enrichment-run-limits";
import { RATE_WINDOW_MS, LocalRateGate } from "../domain/enrichment-rate-limit";
import { aiConfigSchema, DEFAULT_REUSE_DAYS, enrichmentConfigSchema, waterfallConfigSchema } from "../domain/enrichment-config";
import { coerceAiOutput } from "../domain/ai-output-coerce";
import { inputsReady } from "../domain/enrichment-cascade";
import { settleVerdict, type VerificationStatus } from "../domain/enrichment-contracts";
import { acceptsText, inputsCovered } from "../domain/enrichment-inputs";
import { sanitizeOutput, sanitizeOutputString } from "../domain/output-sanitize";
import { boundedAudit, cleanError, redactSecrets } from "../domain/enrichment-redact";
import { cellText, hasCellValue, normalizeDomain, ownCell, tokensIn, validateInput } from "../domain/enrichment-templates";
import { runWaterfall, stepId, type MissVerdict, type StepAttempt, type StepExecution, type WaterfallStep } from "../domain/enrichment-waterfall";
import {
  GridAiError,
  ProviderError,
  type AdapterRegistry,
  type CellAnswerer,
  type CascadeSpec,
  type CellJob,
  type CellWrite,
  type CredentialCipher,
  type GridRunStore,
  type LedgerRun,
  type ProviderStore,
  type RetryState,
} from "./enrichment-ports";
import { cascadeSpecFor, estimateStepCents } from "./enrichment-cost";
import { lookupKey } from "./enrichment-reuse";

export interface WorkerDeps {
  store: GridRunStore;
  providers: ProviderStore;
  adapters: AdapterRegistry;
  cipher: CredentialCipher;
  ai: CellAnswerer;
  now: () => Date;
  workerId: string;
  /** A running job whose lease is older than this is taken over by another worker. */
  leaseMs: number;
  /** Cells one tick runs at the same time. */
  concurrency: number;
  /** Wall-clock limit for one provider call. */
  callTimeoutMs: number;
  gate?: LocalRateGate;
  /** Called after a cell result is saved, with the column keys it wrote. Failures are logged and never fail the job. */
  afterWrite?: (job: CellJob, columnKeys: string[]) => Promise<void>;
}

export const GRID_JOB_LEASE_MS = 5 * 60_000;
export const GRID_CALL_TIMEOUT_MS = 30_000;
/** Name of the scheduler job, shared with the kick. */
export const GRID_RUN_JOB = "grid.run";
/** How often a cell held by a switched-off provider looks again. */
const PAUSED_RETRY_MS = 10 * 60_000;
/** Vendor 429 waits a cell sits through for free. A vendor that keeps answering 429 then uses up attempts, so the cell ends. */
const MAX_FREE_WAITS = 24;
const retryDelayMs = (attempts: number) => Math.min(5 * 60_000, 2000 * 4 ** Math.max(0, attempts - 1));

export { estimateStepCents };

function stepsOf(
  type: string,
  config: Record<string, unknown>,
): { steps: WaterfallStep[]; inputs: Record<string, string>; outputs: Record<string, string>; maxCostCents?: number; maxCredits?: number; waitOnRateLimit?: boolean; reuseDays: number; settled?: VerificationStatus[] } | string {
  if (type === "enrichment") {
    const parsed = enrichmentConfigSchema.safeParse(config);
    if (!parsed.success) return "This column's configuration is invalid. Save it again.";
    return { steps: [{ providerKey: parsed.data.providerKey, actionKey: parsed.data.actionKey }], inputs: parsed.data.inputs, outputs: parsed.data.outputs, reuseDays: parsed.data.reuseDays ?? DEFAULT_REUSE_DAYS, settled: parsed.data.settledStatuses };
  }
  const parsed = waterfallConfigSchema.safeParse(config);
  if (!parsed.success) return "This column's configuration is invalid. Save it again.";
  return { steps: parsed.data.steps, inputs: parsed.data.inputs, outputs: parsed.data.outputs, maxCostCents: parsed.data.maxCostCents, maxCredits: parsed.data.maxCredits, waitOnRateLimit: parsed.data.onRateLimit === "wait", reuseDays: parsed.data.reuseDays ?? DEFAULT_REUSE_DAYS, settled: parsed.data.settledStatuses };
}

/**
 * Runs one provider call for one step: validates inputs, reuses a recent answer to the same lookup, checks the key and
 * the rate limit, calls, and redacts. Only native vendors (actions with credits) reuse answers; a Custom HTTP action
 * may do more than look something up.
 */
async function executeStep(
  deps: WorkerDeps,
  job: CellJob,
  step: WaterfallStep,
  inputsMap: Record<string, string>,
  cells: Record<string, unknown>,
  gate: LocalRateGate,
  reuse: { days: number; fresh: boolean },
): Promise<StepExecution> {
  const provider = await deps.providers.getByKey(job.organizationId, step.providerKey);
  if (!provider) return { kind: "unavailable", message: `Provider "${step.providerKey}" is not connected.` };
  // Switched off pauses the cell: it waits, uses no attempt, and runs once the provider is on again.
  if (!provider.enabled) return { kind: "rate_limited", retryAfterMs: PAUSED_RETRY_MS, message: `${provider.name} is switched off. The cell runs once it is on again.` };
  const adapter = deps.adapters.adapterFor(provider);
  if (!adapter) return { kind: "unavailable", message: `Provider "${step.providerKey}" has no adapter on this server.` };
  const action = adapter.actions(provider).find((a) => a.key === step.actionKey);
  if (!action) return { kind: "unavailable", message: `Provider "${step.providerKey}" has no action "${step.actionKey}".` };

  const inputs: Record<string, unknown> = {};
  for (const input of action.inputs) {
    const column = inputsMap[input.key];
    const value = column ? ownCell(cells, column) : undefined;
    if (!hasCellValue(value)) {
      if (input.required) return { kind: "unavailable", message: `${input.name}: a value is required.` };
      continue;
    }
    const problem = validateInput(input.type, value);
    if (problem) return { kind: "unavailable", message: `${input.name}: ${problem}` };
    inputs[input.key] = input.type === "domain" && typeof value === "string" ? normalizeDomain(value) : value;
  }
  if (!inputsCovered(action, (key) => key in inputs)) return { kind: "unavailable", message: `${action.name} needs ${acceptsText(action)}.` };

  const reusable = reuse.days > 0 && action.creditsPerCall !== undefined;
  const key = reusable ? lookupKey(provider.key, action.key, inputs) : undefined;
  // A fresh run still stores its answer for later cells; it only skips taking one.
  if (key && !reuse.fresh) {
    const earlier = await deps.store.reusableAnswer(job.organizationId, key, new Date(deps.now().getTime() - reuse.days * 86_400_000));
    if (earlier) {
      return {
        kind: "result",
        outcome: earlier.outcome,
        primary: earlier.answer.primary,
        outputs: earlier.answer.outputs,
        costCents: 0,
        credits: 0,
        latencyMs: 0,
        request: { action: action.key, inputKeys: Object.keys(inputs), reusedFrom: earlier.id },
        response: { reused: true, answeredAt: earlier.createdAt.toISOString() },
        reuse: { reused: true },
      };
    }
  }

  let credentials: Record<string, string> = {};
  const envelope = await deps.providers.encryptedCredential(job.organizationId, provider.id);
  if (envelope) {
    try {
      const parsed: unknown = JSON.parse(deps.cipher.decrypt(envelope));
      if (!parsed || typeof parsed !== "object" || Object.values(parsed).some((v) => typeof v !== "string")) throw new Error("bad shape");
      credentials = parsed as Record<string, string>;
    } catch {
      return { kind: "unavailable", message: `The saved credential for "${step.providerKey}" cannot be read. Save the key again.` };
    }
  }
  const secrets = Object.values(credentials);

  const now = deps.now();
  const recent = provider.rateLimitPerMin === null ? [] : await deps.store.recentCalls(job.organizationId, provider.key, new Date(now.getTime() - RATE_WINDOW_MS));
  const gateKey = `${job.organizationId}:${provider.key}`;
  const decision = gate.tryTake(gateKey, recent, now.getTime(), provider.rateLimitPerMin);
  if (!decision.allowed) return { kind: "rate_limited", retryAfterMs: decision.retryAfterMs };

  const started = Date.now();
  try {
    const answer = await adapter.execute({ action: action.key, inputs, credentials, provider, timeoutMs: deps.callTimeoutMs });
    return {
      kind: "result",
      outcome: answer.outcome,
      primary: answer.primary,
      outputs: redactSecrets(answer.outputs, secrets),
      costCents: answer.costCents ?? (answer.billable === false ? 0 : estimateStepCents(provider, action)),
      credits: creditsOf(answer, action),
      latencyMs: Date.now() - started,
      request: boundedAudit(redactSecrets(answer.request ?? { action: action.key, inputKeys: Object.keys(inputs) }, secrets)),
      response: boundedAudit(redactSecrets(answer.response ?? null, secrets)),
      // A found value or a verdict is worth reusing; an empty miss is asked again next time.
      ...(key && (answer.outcome === "hit" || hasCellValue(answer.primary)) ? { reuse: { lookupKey: key, outcome: answer.outcome } } : {}),
    };
  } catch (error) {
    if (error instanceof ProviderError) {
      // The vendor said how long to wait: the other cells of this worker hold off too.
      if (error.transient && error.retryAfterMs !== undefined) gate.hold(gateKey, deps.now().getTime() + error.retryAfterMs);
      return {
        kind: "error",
        transient: error.transient,
        retryAfterMs: error.retryAfterMs,
        message: cleanError(error.message, secrets),
        costCents: 0,
        request: boundedAudit(redactSecrets(error.audit?.request ?? null, secrets)),
        response: boundedAudit(redactSecrets(error.audit?.response ?? null, secrets)),
      };
    }
    // An unexpected exception may be a dropped connection. Retry it, and keep its text away from secrets.
    return { kind: "error", transient: true, message: cleanError(error instanceof Error ? error.message : String(error), secrets) };
  }
}

/** The vendor's own count, else the action's credits per billed call. A provider without credits records none. */
function creditsOf(answer: { credits?: number; billable?: boolean }, action: { creditsPerCall?: number }): number | null {
  if (typeof answer.credits === "number" && Number.isFinite(answer.credits) && answer.credits >= 0) return answer.credits;
  if (action.creditsPerCall === undefined) return null;
  return answer.billable === false ? 0 : action.creditsPerCall;
}

const ledger = (attempts: StepAttempt[]): LedgerRun[] =>
  attempts.map((a) => ({
    provider: a.step.providerKey,
    outcome: a.outcome === "skipped" ? "skipped" : a.outcome,
    costCents: a.costCents,
    credits: a.credits ?? null,
    ...(a.reuse?.lookupKey ? { lookupKey: a.reuse.lookupKey, answer: boundedAudit({ primary: a.reuse.primary ?? null, outputs: a.reuse.outputs ?? {}, ...(a.reuse.outcome ? { outcome: a.reuse.outcome } : {}) }) as LedgerRun["answer"] } : {}),
    ...(a.reuse?.reused ? { reused: true } : {}),
    latencyMs: a.latencyMs ?? null,
    request: sanitizeOutput(a.request ?? { action: a.step.actionKey }),
    response: sanitizeOutput(a.response ?? (a.detail ? { detail: a.detail } : null)),
  }));

/**
 * Saves the result of a call that already ran. The provider was paid, so a failed save never goes back to the queue:
 * the cell ends in a terminal error and the ledger keeps the cost. A person can retry it on purpose.
 */
async function succeedOnce(deps: WorkerDeps, job: CellJob, write: CellWrite, runs: LedgerRun[], cascade: () => Promise<CascadeSpec>): Promise<"saved" | "lease_lost" | "save_failed"> {
  try {
    // Without a cascade spec the dependents wait for a person; the paid result is still saved.
    const spec = await cascade().catch(() => false as const);
    return (await deps.store.succeed(job, write, runs, spec)) ? "saved" : "lease_lost";
  } catch (error) {
    const reason = cleanError(error instanceof Error ? error.message : String(error));
    const message = sanitizeOutputString(`The provider answered and was paid, but the result could not be saved: ${reason}. It was not run again. Retry failed saves it without paying again when the column reuses answers; running the cell asks the provider again.`, 500);
    console.error(`[grid] result of ${job.columnKey} could not be saved after a paid call:`, reason);
    try {
      // The paid answer sits in the ledger: Retry failed takes it without paying, so no fresh flag may survive.
      await deps.store.fail(job, message, runs, {});
    } catch (failure) {
      // The ledger row may be the part that failed. Record the cell error alone; only a dead database leaves the job running.
      await deps.store.fail(job, message, []).catch(() => false);
      console.error("[grid] could not record the failed save with its ledger:", failure instanceof Error ? failure.message : failure);
    }
    return "save_failed";
  }
}

/** Hash of the values the column reads from the row, so saved state from other inputs is not trusted. */
const inputsKeyOf = (columnKey: string, inputs: Record<string, string>, cells: Record<string, unknown>) =>
  lookupKey("cell", columnKey, Object.fromEntries(Object.entries(inputs).map(([inputKey, column]) => [inputKey, ownCell(cells, column) ?? null])));

/**
 * The job's saved state, read with care: it comes back from a JSON column. State saved for other input values (the row
 * was edited since) is dropped, so a step that missed for the old email is asked about the new one.
 */
function retryStateOf(job: CellJob, inputsKey: string): { missed: Set<string>; fallback?: MissVerdict; spentCents: number; spentCredits: number; fresh: boolean } {
  const saved = job.providerState ?? {};
  const fresh = saved.fresh === true;
  const state = saved.inputsKey === undefined || saved.inputsKey === inputsKey ? saved : {};
  const missed = Array.isArray(state.missed) ? state.missed.filter((id): id is string => typeof id === "string") : [];
  const f = state.fallback;
  const fallback =
    f && typeof f === "object" && f.step && typeof f.step.providerKey === "string" && typeof f.step.actionKey === "string" && f.outputs && typeof f.outputs === "object"
      ? { step: { providerKey: f.step.providerKey, actionKey: f.step.actionKey }, primary: f.primary, outputs: f.outputs }
      : undefined;
  const positive = (n: unknown) => (typeof n === "number" && Number.isFinite(n) && n > 0 ? n : 0);
  return { missed: new Set(missed), fallback, spentCents: positive(state.spentCents), spentCredits: positive(state.spentCredits), fresh };
}

/** A transient error that used up an attempt. A vendor's 429 told the cell to wait, which is not the cell's fault. */
const failedTry = (attempts: StepAttempt[]) => attempts.some((a) => a.outcome === "error" && a.retryable && !a.waited);

/** True when this try used the cell's last attempt on a transient error, so a retry would fail it. */
const lastAttempt = (job: CellJob, attempts: StepAttempt[]) => failedTry(attempts) && job.attempts >= job.maxAttempts;

async function finishRetry(deps: WorkerDeps, job: CellJob, attempts: StepAttempt[], state: RetryState, retryAfterMs: number | undefined, message: string) {
  const sawTransientError = failedTry(attempts);
  // A rate-limit wait, ours or the vendor's, does not use up an attempt, up to MAX_FREE_WAITS vendor waits.
  const waited = attempts.some((a) => a.waited);
  const waits = (job.providerState?.waits ?? 0) + (waited ? 1 : 0);
  if (waited) state = { ...state, waits };
  const consumeAttempt = sawTransientError || (waited && waits > MAX_FREE_WAITS);
  if (consumeAttempt && job.attempts >= job.maxAttempts) {
    await deps.store.fail(job, message, ledger(attempts), state);
    return "failed";
  }
  const delay = Math.max(retryAfterMs ?? 0, sawTransientError ? retryDelayMs(job.attempts) : 0, 1000);
  await deps.store.retryLater(job, { runAfter: new Date(deps.now().getTime() + delay), error: message, consumeAttempt, state, runs: ledger(attempts) });
  return "retried";
}

async function notifyWritten(deps: WorkerDeps, job: CellJob, keys: string[]): Promise<void> {
  try {
    await deps.afterWrite?.(job, keys);
  } catch (error) {
    console.error("[grid] after-write hook failed:", error instanceof Error ? error.message : error);
  }
}

async function runProviderColumn(deps: WorkerDeps, job: CellJob, ctx: NonNullable<Awaited<ReturnType<GridRunStore["loadCell"]>>>, gate: LocalRateGate): Promise<string> {
  const { column, cells } = ctx;
  const plan = stepsOf(column.type, column.config);
  if (typeof plan === "string") {
    await deps.store.fail(job, plan, [{ provider: null, outcome: "failed", costCents: 0, response: { error: plan } }]);
    return "failed";
  }
  if (!inputsReady(column, cells)) {
    await deps.store.skip(job, "The input cells are empty.");
    return "skipped";
  }

  // Worst case per step, for the per-cell caps. A missing provider costs nothing because the step is skipped.
  const estimates = new Map<string, number>();
  const creditEstimates = new Map<string, number>();
  for (const step of plan.steps) {
    const provider = await deps.providers.getByKey(job.organizationId, step.providerKey);
    const action = provider ? deps.adapters.adapterFor(provider)?.actions(provider).find((a) => a.key === step.actionKey) : undefined;
    estimates.set(stepId(step), provider ? estimateStepCents(provider, action) : 0);
    creditEstimates.set(stepId(step), action?.creditsPerCall ?? 0);
  }

  const inputsKey = inputsKeyOf(column.key, plan.inputs, cells);
  const carried = retryStateOf(job, inputsKey);
  const result = await runWaterfall(plan.steps, async (step) => {
    const result = await executeStep(deps, job, step, plan.inputs, cells, gate, { days: plan.reuseDays, fresh: carried.fresh });
    return result.kind === "result" ? settleVerdict(step.actionKey, result, plan.settled) : result;
  }, {
    maxCostCents: plan.maxCostCents,
    estimate: (step) => estimates.get(stepId(step)) ?? 0,
    alreadyMissed: carried.missed,
    carriedFallback: carried.fallback,
    carriedSpentCents: carried.spentCents,
    maxCredits: plan.maxCredits,
    estimateCredits: (step) => creditEstimates.get(stepId(step)) ?? 0,
    carriedSpentCredits: carried.spentCredits,
    waitOnRateLimit: plan.waitOnRateLimit,
  });

  // On the last attempt a paid miss verdict is saved as the cell's answer instead of failing the cell.
  if (result.status === "retry" && !(result.fallback && lastAttempt(job, result.attempts))) {
    // The error, else the reason a step was held (a rate limit, a switched-off provider), else the general word.
    const message = result.attempts.find((a) => a.outcome === "error")?.detail ?? result.attempts.find((a) => a.outcome === "skipped" && a.retryable)?.detail ?? "Every provider was busy or unavailable. The cell will run again soon.";
    const state: RetryState = { missed: result.missed, ...(result.fallback ? { fallback: { ...result.fallback, outputs: sanitizeOutput(result.fallback.outputs) as Record<string, unknown> } } : {}), spentCents: result.spentCents, spentCredits: result.spentCredits, inputsKey, ...(carried.fresh ? { fresh: true } : {}) };
    return finishRetry(deps, job, result.attempts, state, result.retryAfterMs, message);
  }
  if (result.status === "failed") {
    await deps.store.fail(job, result.message, ledger(result.attempts));
    return "failed";
  }

  const runAt = deps.now().toISOString();
  const cells2: Record<string, unknown> = {};
  const meta: Record<string, unknown> = {};
  const hit = result.status === "hit";
  // With no hit, the first verdict a vendor gave (a catch-all address) still fills the cells, so a paid answer is kept.
  const answer = hit ? { step: result.winnerStep, primary: result.winner.primary, outputs: result.winner.outputs } : result.fallback;
  // On a miss, the steps that never answered (off, out of credits, over a cap) are named, so "Not found" does not hide them.
  const unanswered = hit ? [] : result.attempts.filter((a) => a.outcome === "skipped" || a.outcome === "error").map((a) => sanitizeOutputString(`${a.step.providerKey}: ${a.detail ?? a.outcome}`, 160));
  const base = {
    status: "success",
    outcome: hit ? "hit" : "miss",
    provider: answer?.step.providerKey,
    costCents: result.spentCents,
    ...(result.attempts.some((a) => typeof a.credits === "number") || result.spentCredits > 0 ? { credits: result.spentCredits } : {}),
    ...(unanswered.length > 0 ? { unanswered } : {}),
    runAt,
  };
  cells2[column.key] = answer ? sanitizeOutputString(cellText(answer.primary)) : "Not found";
  meta[column.key] = base;
  for (const [outputKey, columnKey] of Object.entries(plan.outputs)) {
    cells2[columnKey] = answer ? sanitizeOutput(answer.outputs[outputKey] ?? null) : null;
    meta[columnKey] = base;
  }
  const ok = await succeedOnce(deps, job, { cells: cells2, meta }, ledger(result.attempts), () => cascadeSpecFor(deps, job.organizationId, ctx.columns, Object.keys(cells2)));
  if (ok === "saved") await notifyWritten(deps, job, Object.keys(cells2));
  return ok === "saved" ? (hit ? "hit" : "miss") : ok === "save_failed" ? "failed" : "lease_lost";
}

async function runAiColumn(deps: WorkerDeps, job: CellJob, ctx: NonNullable<Awaited<ReturnType<GridRunStore["loadCell"]>>>): Promise<string> {
  const { column, cells } = ctx;
  const parsed = aiConfigSchema.safeParse(column.config);
  if (!parsed.success) {
    const message = "This AI column's configuration is invalid. Save it again.";
    await deps.store.fail(job, message, [{ provider: null, outcome: "failed", costCents: 0, response: { error: message } }]);
    return "failed";
  }
  const config = parsed.data;
  const referenced = tokensIn(config.prompt);
  const values = referenced.map((key) => ({ key, value: cellText(ownCell(cells, key)).trim() })).filter((c) => c.value !== "");
  if (referenced.length > 0 && values.length === 0) {
    await deps.store.skip(job, "Every referenced cell is empty.");
    return "skipped";
  }

  const started = Date.now();
  let answered: Awaited<ReturnType<CellAnswerer["answer"]>>;
  try {
    answered = await deps.ai.answer(job.organizationId, { instruction: config.prompt, cells: values, outputs: config.outputs });
  } catch (error) {
    const transient = error instanceof GridAiError ? error.transient : true;
    const message = cleanError(error instanceof Error ? error.message : String(error));
    const attempt: StepAttempt = { step: { providerKey: "ai", actionKey: "answer" }, outcome: "error", costCents: 0, detail: message, retryable: transient };
    if (transient) return finishRetry(deps, job, [attempt], {}, undefined, message);
    await deps.store.fail(job, message, ledger([attempt]));
    return "failed";
  }
  if (!answered) {
    const message = "Connect an Anthropic key in Settings, Integrations before running AI columns.";
    await deps.store.fail(job, message, [{ provider: "ai", outcome: "failed", costCents: 0, response: { error: message } }]);
    return "failed";
  }

  const output = sanitizeOutput(answered.output);
  // The model answers email, url, date and json fields as text. Check each one before it reaches a typed column. A
  // rejected answer becomes that cell's error; the call was paid for, so nothing runs again and the other fields still save.
  const coerced = new Map<string, ReturnType<typeof coerceAiOutput>>(config.outputs.map((f) => [f.key, coerceAiOutput(f.type, output[f.key])]));
  const rejected = config.outputs.flatMap((f) => {
    const r = coerced.get(f.key);
    return r && !r.ok ? [{ field: f.key, message: r.message }] : [];
  });
  const hasResult = config.outputs.some((f) => {
    const r = coerced.get(f.key);
    return r?.ok === true && r.value !== null && r.value !== undefined;
  });
  const label = sanitizeOutputString(`${answered.provider}/${answered.model}`, 200);
  const base = { status: "success", outcome: hasResult ? "hit" : "miss", provider: label, costCents: 0, runAt: deps.now().toISOString() };
  const write: CellWrite = { cells: { [column.key]: hasResult ? "Completed" : "No result" }, meta: { [column.key]: base } };
  for (const field of config.outputs) {
    const columnKey = config.outputColumns[field.key];
    if (!columnKey) continue;
    const result = coerced.get(field.key)!;
    if (result.ok) {
      write.cells[columnKey] = sanitizeOutput(result.value ?? null);
      write.meta[columnKey] = base;
    } else {
      // No value key: a rejected answer must not wipe the value an earlier good run (or a person) left in the cell. Only the error is recorded.
      write.meta[columnKey] = { ...base, status: "error", outcome: "error", error: sanitizeOutputString(`${result.message} The answer was not saved. Run the cell again to ask again.`, 500) };
    }
  }
  const run: LedgerRun = {
    provider: label,
    outcome: hasResult ? "hit" : "miss",
    costCents: 0,
    latencyMs: Date.now() - started,
    request: { instruction: config.prompt, cellKeys: values.map((c) => c.key), outputs: config.outputs.map((f) => f.key) },
    response: { output, ...(rejected.length > 0 ? { rejected } : {}), usage: sanitizeOutput(answered.usage ?? null) },
  };
  const ok = await succeedOnce(deps, job, write, [run], () => cascadeSpecFor(deps, job.organizationId, ctx.columns, Object.keys(write.cells)));
  if (ok === "saved") await notifyWritten(deps, job, Object.keys(write.cells));
  return ok === "saved" ? (hasResult ? "hit" : "miss") : ok === "save_failed" ? "failed" : "lease_lost";
}

/** Runs one claimed job to a terminal or retry state. Returns the outcome name for the tick report. */
export async function runCell(deps: WorkerDeps, job: CellJob, gate: LocalRateGate = deps.gate ?? new LocalRateGate()): Promise<string> {
  const ctx = await deps.store.loadCell(job);
  if (!ctx) {
    await deps.store.fail(job, "The column or the row no longer exists.", []);
    return "failed";
  }
  if (ctx.column.type === "ai") return runAiColumn(deps, job, ctx);
  if (ctx.column.type === "enrichment" || ctx.column.type === "waterfall") return runProviderColumn(deps, job, ctx, gate);
  const message = `Column type "${ctx.column.type}" cannot be run here.`;
  await deps.store.fail(job, message, [{ provider: null, outcome: "failed", costCents: 0, response: { error: message } }]);
  return "failed";
}

/**
 * `grid.run`: claims due cell jobs (one job per cell, SKIP LOCKED with a lease) and runs them in a slot pool.
 * Up to `concurrency` cells run at once; the moment one finishes, its slot claims the next job, so one slow cell
 * never holds the others. The pass ends when the queue is empty, the safety ceiling is reached, or the tick budget
 * (`ctx.deadline`, read from the injected clock) runs out. Cells already running at the deadline finish before the
 * pass returns. Two workers can call it at once; a cell is never run twice at the same time.
 */
export function createGridRunJob(deps: WorkerDeps): Job {
  const gate = deps.gate ?? new LocalRateGate();
  const concurrency = clampConcurrency(deps.concurrency);
  return {
    name: GRID_RUN_JOB,
    async run(ctx) {
      const detail: Record<string, number> = {};
      const active = new Set<Promise<void>>();
      let claimed = 0;
      let more = false;
      // True after a claim returned fewer jobs than asked for. The next claim waits for a slot to finish.
      let queueDry = false;

      const start = (job: CellJob) => {
        const task: Promise<void> = runCell(deps, job, gate)
          .catch(async (error) => {
            // A bug or a dropped connection must not strand the cell in `running` until the lease expires.
            const message = cleanError(error instanceof Error ? error.message : String(error));
            if (job.attempts >= job.maxAttempts) await deps.store.fail(job, message, []).catch(() => false);
            else await deps.store.retryLater(job, { runAfter: new Date(deps.now().getTime() + retryDelayMs(job.attempts)), error: message, consumeAttempt: true, state: job.providerState ?? {}, runs: [] }).catch(() => false);
            return "error";
          })
          .then((outcome) => {
            detail[outcome] = (detail[outcome] ?? 0) + 1;
          })
          .catch(() => undefined)
          .finally(() => {
            active.delete(task);
          });
        active.add(task);
      };

      // Refills wait for two free slots (one when concurrency is 1, or when nothing runs), so a steady state of
      // one-cell completions does not pay for a full claim per cell.
      const refillAt = Math.min(2, concurrency);
      // The exhausted-job sweep runs on the first claim of the pass and after every short claim.
      let sweepExhausted = true;
      let lastClaimShort = false;
      try {
        for (;;) {
          if (claimed >= MAX_JOBS_PER_TICK || ctx.now().getTime() >= ctx.deadline) {
            more = true;
            break;
          }
          const free = Math.min(concurrency - active.size, MAX_JOBS_PER_TICK - claimed);
          if (free > 0 && !queueDry && (free >= refillAt || active.size === 0)) {
            const jobs = await deps.store.claim(deps.now(), deps.leaseMs, free, deps.workerId, { sweepExhausted });
            claimed += jobs.length;
            const short = jobs.length < free;
            // A short claim can mean a concurrent claimer held the top candidates, not that the queue is empty.
            // One short claim with jobs gets an immediate retry; an empty claim or a second short one ends the refill.
            queueDry = short && (jobs.length === 0 || lastClaimShort);
            lastClaimShort = short;
            sweepExhausted = short;
            for (const job of jobs) start(job);
            // The claim took time; look at the budget again before waiting.
            if (!queueDry) continue;
          }
          // Nothing running and nothing claimable: the queue is drained.
          if (active.size === 0) break;
          await Promise.race(active);
          queueDry = false;
        }
      } finally {
        // Cells in flight always settle before the pass returns or rejects, so none is left running past its lease.
        await Promise.allSettled([...active]);
      }
      return { processed: claimed, more, detail };
    },
  };
}
