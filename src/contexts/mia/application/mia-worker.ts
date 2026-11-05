import { randomBytes } from "node:crypto";
import type { AgentModelResolver, AgentStepResult } from "@/contexts/ai/application/agent-ports";
import { AiError } from "@/contexts/ai/domain/ai-error";
import { AI_TASKS } from "@/contexts/ai/domain/ai-tasks";
import { fence } from "@/contexts/ai/domain/prompt-fence";
import { aiOffMessage } from "@/contexts/integrations/domain/ai-status";
import type { Job } from "@/platform/jobs/types";
import { errorText } from "@/shared/error-text";
import { MIA_CONCURRENCY, MIA_LEASE_MS, MIA_MAX_FAILURES, MIA_MAX_STEPS, MIA_MIN_STEP_ROOM_MS, MIA_RUN_TOKENS, MIA_STEP_TIMEOUT_MS, miaRetryDelayMs } from "../domain/mia-run";
import { backgroundTokenLimit, countedTokens, estimatedTokens, nextUtcMidnight } from "../domain/mia-settings";
import { FILL_TEXT_SYSTEM, FILL_URL_SYSTEM, LAST_STEP_MESSAGE, NUDGE_MESSAGE, SORT_SYSTEM } from "../domain/prompts";
import type { ClaimedRun, MiaBrainPort, MiaRunStore, MiaSettingsStore, PageReader } from "./mia-ports";
import { runTools, sourcesOf, type RunState } from "./run-tools";

export const MIA_RUN_JOB = "mia.run";
/** Mia's passes make model calls, so they keep to their own lane and a Tables run does not wait for one. */
export const MIA_KICK_LANE = "mia";

export interface MiaWorkerDeps {
  runs: MiaRunStore;
  models: AgentModelResolver;
  pages: PageReader;
  brain: MiaBrainPort;
  settings: Pick<MiaSettingsStore, "read">;
  now: () => Date;
  /** Runs this job again soon, on its own lane. */
  kick: () => void;
  installEnabled: () => boolean;
}

type StepOutcome = "continue" | "ended";

const nonce = () => randomBytes(6).toString("hex");

const SYSTEM = { brain_fill_url: FILL_URL_SYSTEM, brain_fill_text: FILL_TEXT_SYSTEM, brain_sort: SORT_SYSTEM } as const;

const MAX_OUTPUT = AI_TASKS["mia.brain_fill"].maxTokens;

/** Where a run starts: the person's text or address as its first message. Null when the document to sort is gone. */
async function firstState(deps: MiaWorkerDeps, run: ClaimedRun): Promise<RunState | null> {
  const empty = { messages: [], pages: [], allowedUrls: [], suggested: [], nudged: false, inputText: null, sorting: null };
  if (run.capability === "brain_fill_url") {
    const url = String(run.input.url);
    return { ...empty, allowedUrls: [url], messages: [{ role: "user", content: `Read this site and suggest Brain items: ${url}` }] };
  }
  if (run.capability === "brain_fill_text") {
    const text = String(run.input.text);
    return { ...empty, inputText: text, messages: [{ role: "user", content: `Suggest Brain items from this text:\n${fence("text", text, nonce())}` }] };
  }
  const doc = await deps.brain.legacyDocument(run.organizationId, String(run.input.itemId));
  if (!doc) return null;
  const fenceId = nonce();
  return { ...empty, inputText: doc.content, sorting: { id: doc.id, title: doc.title }, messages: [{ role: "user", content: `Sort this document. Its title:\n${fence("title", doc.title, fenceId)}\nIts text:\n${fence("text", doc.content, fenceId)}` }] };
}

/** One model call and what follows from it. "continue" means the run holds its claim and has more to do. */
async function runStep(deps: MiaWorkerDeps, run: ClaimedRun): Promise<StepOutcome> {
  const now = deps.now();
  if (await deps.runs.cancelRequested(run)) {
    await deps.runs.cancelled(run, now);
    return "ended";
  }
  const fail = async (error: string, failureKind: string, chargedTokens?: number) => {
    await deps.runs.fail(run, { error, failureKind, now, ...(chargedTokens === undefined ? {} : { chargedTokens }) });
    return "ended" as const;
  };
  /** Measured from now, not from the start of the step: a step that timed out has already used more than the first wait. */
  const retryAt = () => new Date(deps.now().getTime() + miaRetryDelayMs(run.failures + 1));
  /** A run that stops early keeps what it found. Only one with nothing to show has failed. */
  const stopWithFindings = async (error: string, failureKind: string) => {
    if (run.suggestionCount === 0) return fail(error, failureKind);
    await deps.runs.succeed(run, deps.now());
    return "ended" as const;
  };
  if (run.failures >= MIA_MAX_FAILURES) return fail("Mia stopped after several failed tries. Start it again.", "attempts");

  const settings = await deps.settings.read(run.organizationId);
  if (!deps.installEnabled() || !settings.enabled) return fail("Mia is off in this organization.", "off");
  if ((await deps.runs.usedToday(run.organizationId, now)) >= backgroundTokenLimit(settings)) {
    await deps.runs.release(run, nextUtcMidnight(now), "waiting_limit");
    return "ended";
  }

  const model = await deps.models.forOrganization(run.organizationId);
  if (!model) return fail(aiOffMessage(await deps.models.status(run.organizationId)) ?? "AI is off.", "off");

  const state = (run.checkpoint as RunState | null) ?? (await firstState(deps, run));
  if (!state) return fail("That document was sorted or removed.", "gone");

  const lastStep = run.stepCount + 1 >= MIA_MAX_STEPS || run.usedTokens >= MIA_RUN_TOKENS * 0.8;
  const messages = lastStep ? [...state.messages, { role: "user", content: LAST_STEP_MESSAGE }] : state.messages;
  const step = runTools({
    organizationId: run.organizationId,
    capability: run.capability,
    state,
    sources: sourcesOf(state),
    suggestionsSoFar: run.suggestionCount,
    pages: deps.pages,
    brain: deps.brain,
  });

  let result: AgentStepResult;
  try {
    result = await model.step({
      task: "mia.brain_fill",
      system: [{ text: SYSTEM[run.capability] }],
      messages,
      tools: step.tools,
      ...(lastStep ? { activeTools: ["suggest_item", "finish"] } : {}),
      maxTokens: MAX_OUTPUT,
      timeoutMs: MIA_STEP_TIMEOUT_MS,
    });
  } catch (error) {
    const message = error instanceof AiError ? error.message : "Mia could not finish that step.";
    const permanent = error instanceof AiError && error.kind === "permanent";
    const failure = { error: message, failureKind: permanent ? "permanent" : "transient", chargedTokens: estimatedTokens(JSON.stringify(messages)), now };
    if (permanent || run.failures + 1 >= MIA_MAX_FAILURES) await deps.runs.fail(run, failure);
    else await deps.runs.retryLater(run, retryAt(), failure);
    return "ended";
  }

  if (result.stop === "refusal") return fail("The model declined this job.", "refused", countedTokens(result.usage));
  if (result.stop === "max_tokens" && result.toolCalls.length === 0) {
    await deps.runs.retryLater(run, retryAt(), { error: "The model's answer was cut off.", failureKind: "transient", chargedTokens: countedTokens(result.usage), now });
    return "ended";
  }

  // Some models cannot be forced to call a tool, so a step of plain text gets one reminder.
  const wroteOnly = result.toolCalls.length === 0;
  const nextMessages = wroteOnly ? [...result.messages, { role: "user", content: NUDGE_MESSAGE }] : result.messages;
  const nextState: RunState = { ...state, messages: nextMessages, nudged: wroteOnly ? true : state.nudged };
  const finished = step.finished();

  const usedNow = run.usedTokens + countedTokens(result.usage);
  const held = await deps.runs.saveStep(run, { checkpoint: nextState as unknown as Record<string, unknown>, usage: result.usage, provider: model.provider, model: model.model, suggestions: step.pending, finished, now: deps.now(), leaseMs: MIA_LEASE_MS });
  if (!held || finished) return "ended";
  run.checkpoint = nextState as unknown as Record<string, unknown>;
  run.stepCount += 1;
  run.usedTokens = usedNow;
  run.suggestionCount += step.pending.length;
  run.failures = 0;

  if (wroteOnly && state.nudged) return stopWithFindings("The model did not use its tools.", "no_tool_call");
  if (run.stepCount >= MIA_MAX_STEPS || run.usedTokens >= MIA_RUN_TOKENS) return stopWithFindings("Mia reached its limit for one job before it found anything to suggest.", "limit");
  return "continue";
}

/** Carries one run as far as the budget allows, so its next call stays inside the provider's prompt cache. */
async function driveRun(deps: MiaWorkerDeps, run: ClaimedRun, deadline: number, count: (key: string) => void): Promise<boolean> {
  for (;;) {
    let outcome: StepOutcome;
    try {
      if (deadline - Date.now() < MIA_MIN_STEP_ROOM_MS) {
        await deps.runs.release(run, deps.now(), "queued");
        return true;
      }
      outcome = await runStep(deps, run);
    } catch (error) {
      // A bug or a dropped connection must not strand the run until its lease expires.
      console.error(`[mia] ${JSON.stringify({ event: "run.step_failed", run: run.id, error: errorText(error) })}`);
      await deps.runs.retryLater(run, new Date(deps.now().getTime() + miaRetryDelayMs(run.failures + 1)), { error: "Mia could not finish that step.", failureKind: "transient", now: deps.now() }).catch(() => false);
      count("failed");
      return false;
    }
    count("steps");
    if (outcome === "ended") return false;
  }
}

/**
 * `mia.run`: claims due runs into a small pool and carries each as far as the budget allows. A step never starts with less
 * than a call's worth of budget left, so this job cannot push a tick past its budget. When work remains it asks for another
 * pass on Mia's own lane. The tick is the way back after a restart, since kick state lives in memory.
 */
export function createMiaRunJob(deps: MiaWorkerDeps): Job {
  return {
    name: MIA_RUN_JOB,
    failureKeys: ["failed"],
    async run(ctx) {
      const detail: Record<string, number> = {};
      const count = (key: string) => void (detail[key] = (detail[key] ?? 0) + 1);
      let more = false;
      if (ctx.deadline - Date.now() < MIA_MIN_STEP_ROOM_MS) more = await deps.runs.hasDue(deps.now());
      else {
        const active = new Set<Promise<void>>();
        for (;;) {
          const free = MIA_CONCURRENCY - active.size;
          const room = ctx.deadline - Date.now() >= MIA_MIN_STEP_ROOM_MS;
          const claimed = free > 0 && room ? await deps.runs.claim(deps.now(), MIA_LEASE_MS, free) : [];
          for (const run of claimed) {
            const task: Promise<void> = driveRun(deps, run, ctx.deadline, count)
              .then((handedBack) => {
                more ||= handedBack;
              })
              .finally(() => active.delete(task));
            active.add(task);
          }
          if (active.size === 0) break;
          await Promise.race(active);
        }
      }
      if (more) deps.kick();
      return { processed: detail.steps ?? 0, more, detail };
    },
  };
}
