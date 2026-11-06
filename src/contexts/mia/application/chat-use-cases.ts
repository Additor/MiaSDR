import type { AgentModel, AgentModelResolver } from "@/contexts/ai/application/agent-ports";
import type { AiUsage } from "@/contexts/ai/domain/generation";
import { AiError } from "@/contexts/ai/domain/ai-error";
import { AI_TASKS } from "@/contexts/ai/domain/ai-tasks";
import { aiOffMessage, type AiStatus } from "@/contexts/integrations/domain/ai-status";
import { isOwnerOrAdmin } from "@/contexts/tenancy/domain/roles";
import { errorText } from "@/shared/error-text";
import { ConflictError, NotFoundError, ValidationError, type Actor } from "@/shared/errors";
import { isUuid } from "@/shared/uuid";
import { aboutPersonNote, CHAT_SYSTEM } from "../domain/chat-prompts";
import { CHAT_MAX_STEPS, CHAT_MESSAGE_CHARS, CHAT_SAVE_MS, CHAT_THREADS_PAGE, CHAT_TIMEOUT_MS, CHAT_TITLE_CHARS, CHAT_TURN_TOKENS, CHAT_TURNS_PER_HOUR, partsText, shownStatus, type ChatPart, type MiaMessageStatus } from "../domain/mia-chat";
import { estimatedTokens, nextUtcMidnight } from "../domain/mia-settings";
import type { ClaimedTurn, MessageRow, MiaChatReads, MiaChatStore, ThreadRow, TurnStart } from "./chat-ports";
import { chatTools } from "./chat-tools";
import type { MiaRunStore, MiaSettingsStore } from "./mia-ports";
import { miaUnavailable } from "./mia-use-cases";

export interface MiaChatDeps {
  chats: MiaChatStore;
  reads: MiaChatReads;
  models: AgentModelResolver;
  settings: Pick<MiaSettingsStore, "read">;
  runs: Pick<MiaRunStore, "usedToday">;
  aiStatus: (organizationId: string) => Promise<AiStatus>;
  installEnabled: () => boolean;
  now: () => Date;
}

/** What a turn tells whoever is watching it. The turn goes on when nobody is. */
export interface TurnListener {
  text(delta: string): void;
  tool(part: Extract<ChatPart, { type: "tool" }>): void;
  end(result: { status: MiaMessageStatus; error: string | null }): void;
}

/**
 * Answers this process is writing, by answer id, so Stop reaches the call at once. The app runs as one process
 * (docs/deploy/self-host.md); a Stop that lands elsewhere still stops the answer at its next save.
 */
const live = new Map<string, AbortController>();

export interface ChatView {
  thread: ThreadRow;
  messages: Array<Omit<MessageRow, "updatedAt">>;
  /** An answer is being written now. */
  going: boolean;
}

export const listChats = (deps: Pick<MiaChatDeps, "chats">, actor: Actor): Promise<ThreadRow[]> => deps.chats.listThreads(actor.organizationId, actor.userId, CHAT_THREADS_PAGE);

export async function openChat(deps: Pick<MiaChatDeps, "chats" | "now">, actor: Actor, threadId: string): Promise<ChatView> {
  const thread = isUuid(threadId) ? await deps.chats.thread(actor.organizationId, actor.userId, threadId) : null;
  if (!thread) throw new NotFoundError("Chat not found");
  const now = deps.now();
  const messages = (await deps.chats.messages(actor.organizationId, thread.id)).map(({ updatedAt, ...m }) => ({ ...m, status: shownStatus({ status: m.status, updatedAt }, now) }));
  return { thread, messages, going: messages.some((m) => m.status === "streaming") };
}

/** A new chat. From a lead's page it starts about that lead. */
export async function newChat(deps: Pick<MiaChatDeps, "chats">, actor: Actor, personId: string | null): Promise<{ id: string }> {
  if (personId !== null && !isUuid(personId)) throw new NotFoundError("This lead no longer exists.");
  const created = await deps.chats.createThread(actor.organizationId, actor.userId, personId);
  if (!created) throw new NotFoundError("This lead no longer exists.");
  return created;
}

export async function renameChat(deps: Pick<MiaChatDeps, "chats">, actor: Actor, threadId: string, raw: string): Promise<void> {
  const title = raw.trim().replace(/\s+/g, " ");
  if (title === "") throw new ValidationError("Give the chat a name.");
  if (title.length > CHAT_TITLE_CHARS * 2) throw new ValidationError(`A chat's name is at most ${CHAT_TITLE_CHARS * 2} characters.`);
  const found = isUuid(threadId) && (await deps.chats.rename(actor.organizationId, actor.userId, threadId, title));
  if (!found) throw new NotFoundError("Chat not found");
}

export async function deleteChat(deps: Pick<MiaChatDeps, "chats">, actor: Actor, threadId: string): Promise<void> {
  const found = isUuid(threadId) && (await deps.chats.remove(actor.organizationId, actor.userId, threadId));
  if (!found) throw new NotFoundError("Chat not found");
}

/** Why a person cannot ask now, as the error the route answers with. */
async function assertCanAsk(deps: MiaChatDeps, actor: Actor): Promise<void> {
  const reason = await miaUnavailable(deps, actor);
  if (reason) throw new ConflictError(reason, { code: "mia_off" });
  const now = deps.now();
  const asked = await deps.chats.questionsSince(actor.organizationId, actor.userId, new Date(now.getTime() - 3_600_000));
  if (asked >= CHAT_TURNS_PER_HOUR) throw new ConflictError(`You have asked Mia ${CHAT_TURNS_PER_HOUR} questions in the last hour. Ask again in a few minutes.`, { code: "mia_chat_limit" });
  const settings = await deps.settings.read(actor.organizationId);
  // A chat may use the whole day's limit: background jobs stop earlier to leave this share for people.
  if ((await deps.runs.usedToday(actor.organizationId, now)) >= settings.dailyTokenLimit) {
    const retryAfterSeconds = Math.ceil((nextUtcMidnight(now).getTime() - now.getTime()) / 1000);
    const who = isOwnerOrAdmin(actor.role) ? "you can raise the limit in Settings, Organization" : "an owner or admin raises the limit";
    throw new ConflictError(`Mia has used today's tokens. Ask again after midnight UTC, or ${who}.`, { code: "mia_daily_limit", retryAfterSeconds });
  }
}

export interface TurnHandle {
  answerId: string;
  /** False when this question was sent already: the answer is the one stored. */
  started: boolean;
  /** Settles when the answer is stored. */
  done: Promise<void>;
}

async function beginTurn(deps: MiaChatDeps, actor: Actor, threadId: string, start: () => Promise<TurnStart | { kind: "nothing" }>, listener: TurnListener): Promise<TurnHandle> {
  if (!isUuid(threadId) || !(await deps.chats.thread(actor.organizationId, actor.userId, threadId))) throw new NotFoundError("Chat not found");
  await assertCanAsk(deps, actor);
  const model = await deps.models.forOrganization(actor.organizationId);
  if (!model) throw new ConflictError(aiOffMessage(await deps.models.status(actor.organizationId)) ?? "AI is off.", { code: "mia_off" });
  const started = await start();
  if (started.kind === "gone") throw new NotFoundError("Chat not found");
  if (started.kind === "busy") throw new ConflictError("Mia is still answering in this chat. Wait for it, or stop it.", { code: "turn_running" });
  if (started.kind === "nothing") throw new ConflictError("The last answer is complete. Ask a new question instead.", { code: "nothing_to_retry" });
  if (started.kind === "duplicate") return { answerId: started.answerId, started: false, done: Promise.resolve() };
  const { turn } = started;
  return { answerId: turn.answerId, started: true, done: runTurn(deps, model, turn, listener) };
}

/** Asks Mia in this chat. The answer goes on to the end when the person leaves the page; a reload shows what it saved. */
export function askMia(deps: MiaChatDeps, actor: Actor, threadId: string, input: { clientId: string; text: string }, listener: TurnListener): Promise<TurnHandle> {
  const text = input.text.trim();
  if (text === "") return Promise.reject(new ValidationError("Write a question."));
  if (text.length > CHAT_MESSAGE_CHARS) return Promise.reject(new ValidationError(`A question is at most ${CHAT_MESSAGE_CHARS.toLocaleString("en-US")} characters.`));
  const clientId = input.clientId.trim();
  if (clientId === "" || clientId.length > 100) return Promise.reject(new ValidationError("The question needs an id."));
  return beginTurn(deps, actor, threadId, () => deps.chats.startTurn(actor.organizationId, actor.userId, threadId, { clientId, text, now: deps.now() }), listener);
}

/** A new answer to the chat's last question, after one that failed, stopped or was cut off. */
export const retryAnswer = (deps: MiaChatDeps, actor: Actor, threadId: string, listener: TurnListener): Promise<TurnHandle> =>
  beginTurn(deps, actor, threadId, () => deps.chats.retryTurn(actor.organizationId, actor.userId, threadId, deps.now()), listener);

export async function stopAnswer(deps: Pick<MiaChatDeps, "chats">, actor: Actor, threadId: string): Promise<void> {
  const answerId = isUuid(threadId) ? await deps.chats.stop(actor.organizationId, actor.userId, threadId) : null;
  if (!answerId) throw new NotFoundError("No answer is being written in this chat.");
  live.get(answerId)?.abort();
}

const STOP_ERRORS = {
  refusal: "The model declined to answer.",
  other: "The answer was cut off. Try again.",
  limit: "Mia reached its limit for one answer, so this answer may be short.",
  max_tokens: "This answer reached its length limit and ends early. Retry, or ask for a shorter answer.",
} as const;

const plus = (a: AiUsage, b: AiUsage): AiUsage => ({
  inputTokens: a.inputTokens + b.inputTokens,
  outputTokens: a.outputTokens + b.outputTokens,
  cacheReadTokens: (a.cacheReadTokens ?? 0) + (b.cacheReadTokens ?? 0),
  cacheWriteTokens: (a.cacheWriteTokens ?? 0) + (b.cacheWriteTokens ?? 0),
  ...(a.costUsd !== undefined || b.costUsd !== undefined ? { costUsd: (a.costUsd ?? 0) + (b.costUsd ?? 0) } : {}),
});

async function runTurn(deps: MiaChatDeps, model: AgentModel, turn: ClaimedTurn, listener: TurnListener): Promise<void> {
  const controller = new AbortController();
  live.set(turn.answerId, controller);
  const parts: ChatPart[] = [];
  let lastSave = Date.now();
  let saving = false;
  const save = () => {
    if (saving) return;
    saving = true;
    lastSave = Date.now();
    deps.chats
      .saveAnswer(turn, structuredClone(parts))
      // A stopped or deleted answer takes no more text, and the call stops with it.
      .then((held) => void (held || controller.abort()))
      .catch((error: unknown) => console.error(`[mia] ${JSON.stringify({ event: "chat.save_failed", answer: turn.answerId, error: errorText(error) })}`))
      .finally(() => void (saving = false));
  };
  const addText = (delta: string) => {
    const last = parts.at(-1);
    if (last?.type === "text") last.text += delta;
    else parts.push({ type: "text", text: delta });
  };

  let status: "complete" | "stopped" | "failed" = "complete";
  let error: string | null = null;
  // What the provider counted for the steps that finished, and whether a step was cut off before it reported.
  let finished: AiUsage = { inputTokens: 0, outputTokens: 0 };
  let cutOff = false;
  try {
    const result = await model.chat({
      task: "mia.chat",
      system: [{ text: CHAT_SYSTEM }, ...(turn.personId ? [{ text: aboutPersonNote(turn.personId) }] : [])],
      messages: turn.history,
      tools: chatTools({
        turn,
        reads: deps.reads,
        store: deps.chats,
        onPart: (part) => {
          parts.push(part);
          listener.tool(part);
        },
      }),
      maxSteps: CHAT_MAX_STEPS,
      maxTokens: AI_TASKS["mia.chat"].maxTokens,
      turnTokens: CHAT_TURN_TOKENS,
      timeoutMs: CHAT_TIMEOUT_MS,
      signal: controller.signal,
      onText: (delta) => {
        addText(delta);
        listener.text(delta);
        if (Date.now() - lastSave >= CHAT_SAVE_MS) save();
      },
      onToolCall: () => save(),
      onStepUsage: (step) => void (finished = plus(finished, step)),
    });
    cutOff = result.stop === "stopped" || result.stop === "other";
    if (result.stop === "stopped") status = "stopped";
    else if (result.stop === "refusal" || result.stop === "other" || result.stop === "max_tokens") {
      status = "failed";
      error = STOP_ERRORS[result.stop];
    } else if (result.stop === "limit" && result.text === "") {
      status = "failed";
      error = STOP_ERRORS.limit;
    }
  } catch (caught) {
    status = "failed";
    cutOff = true;
    error = caught instanceof AiError ? caught.message : "Mia could not answer. Try again.";
    if (!(caught instanceof AiError)) console.error(`[mia] ${JSON.stringify({ event: "chat.turn_failed", answer: turn.answerId, error: errorText(caught) })}`);
  } finally {
    live.delete(turn.answerId);
  }
  // A step cut off by Stop or an error reports no usage, but the provider bills it. Its prompt held at least the system
  // text and the history, and its answer at most what was written, so the estimate adds both and errs high.
  const usage = cutOff ? plus(finished, { inputTokens: estimatedTokens(CHAT_SYSTEM + JSON.stringify(turn.history)), outputTokens: estimatedTokens(partsText(parts)) }) : finished;
  try {
    await deps.chats.endTurn(turn, { status, parts, usage, provider: model.provider, model: model.model, error, now: deps.now() });
  } catch (caught) {
    // The next question takes the turn once it is stale, and the answer then shows as interrupted.
    console.error(`[mia] ${JSON.stringify({ event: "chat.end_failed", answer: turn.answerId, error: errorText(caught) })}`);
  }
  listener.end({ status, error });
}
