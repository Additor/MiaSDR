import { errorText } from "@/shared/error-text";
import { MAX_SEND_ATTEMPTS } from "../../domain/send-policy";
import { inviteRetryMinutes } from "../domain/linkedin";
import { OPERATION_HELD_PAUSE_MINUTES, REPLY_CHECK_RETRY_MINUTES, nextOperationStep, operationGone } from "../domain/linkedin-operations";
import { receiveLinkedInWebhook } from "./linkedin-inbound";
import { LinkedInGatewayError, type LinkedInEngineDeps, type LinkedInGateway, type LinkedInGatewayOperations, type LinkedInInboundDeps, type LinkedInOpenOperationStore, type OpenLinkedInOperation, type OperationProgress, type SearchPage } from "./linkedin-ports";
import type { LinkedInSearchEngineDeps } from "./linkedin-search-ports";
import { handleSearchError, recordSearchRead } from "./run-linkedin-search";
import { fallsBackToApi, handleLookupError, handleReplyCheckError, handleSendError, lookupInput, lookupWithoutAccess, writeLookup } from "./send-next-linkedin";

export interface LinkedInSettleDeps {
  operations: LinkedInOpenOperationStore;
  engine: LinkedInEngineDeps;
  search: LinkedInSearchEngineDeps;
  inbound: LinkedInInboundDeps;
}

export interface LinkedInSettleReport {
  checked: number;
  settled: number;
  failed: number;
}

const BATCH = 50;
const NOTHING_NEW = "The LinkedIn provider did not finish this in time, and it was stopped.";

/**
 * Reads what vendors finished and writes each outcome through the same path as a vendor that answers at once. One failing row
 * stays open for the next tick and cannot stop the others. `deadline` is this job's share of the tick.
 *
 * Only a finished read or a confirmed cancel gives anything back. A read that failed says nothing about the send, so that row waits.
 */
export async function settleLinkedInOperations(deps: LinkedInSettleDeps, deadline: number): Promise<LinkedInSettleReport> {
  const report: LinkedInSettleReport = { checked: 0, settled: 0, failed: 0 };
  for (const operation of await deps.operations.listOpen(BATCH)) {
    if (Date.now() >= deadline) break;
    report.checked += 1;
    try {
      if (await settleOne(deps, operation)) report.settled += 1;
    } catch (error) {
      report.failed += 1;
      console.error(`LinkedIn settle: operation ${operation.id} failed: ${errorText(error)}`);
    }
  }
  return report;
}

type Read = OperationProgress<OpenLinkedInOperation["kind"]>;

async function readProgress(operations: LinkedInGatewayOperations | undefined, operation: OpenLinkedInOperation): Promise<Read | null> {
  if (!operations) return null;
  try {
    return await operations.progress({ account: operation.providerAccountRef, operation: operation.operation, kind: operation.kind });
  } catch {
    return null;
  }
}

async function subjectLive(deps: LinkedInSettleDeps, operation: OpenLinkedInOperation): Promise<boolean> {
  if (!operation.subject) return false;
  if (operation.kind === "invitation" || operation.kind === "message") return (await deps.engine.store.checkBlockers(operation.subject)) === null;
  return "live" in operation.subject ? operation.subject.live : true;
}

async function settleOne(deps: LinkedInSettleDeps, operation: OpenLinkedInOperation): Promise<boolean> {
  const now = deps.engine.clock.now();
  await deps.operations.noteChecked(operation.id, now);
  const gateway = await deps.engine.gateways.forAccount({ organizationId: operation.organizationId, accountId: operation.accountId });
  const read = await readProgress(gateway?.operations, operation);
  if (read && read.state !== "waiting") return finish(deps, gateway as LinkedInGateway, operation, read);

  const step = nextOperationStep({ submittedAt: operation.submittedAt, now, read: read ? { held: read.held } : null, subjectLive: await subjectLive(deps, operation) });
  if (step === "wait") return false;
  if (step === "give_up") return closeAfterTimeout(deps, operation);

  let answer: "cancelled" | "already_finished";
  try {
    answer = await (gateway as LinkedInGateway).operations!.cancel({ account: operation.providerAccountRef, operation: operation.operation });
  } catch {
    // Not confirmed, so it may still run. It stays open, and after a day it closes by its kind.
    return operationGone(operation.submittedAt, now) ? closeAfterTimeout(deps, operation) : false;
  }
  if (answer === "already_finished") {
    const last = await readProgress(gateway?.operations, operation);
    if (last && last.state !== "waiting") return finish(deps, gateway as LinkedInGateway, operation, last);
    // A vendor that says "too late" and "still running" forever must not hold the account forever.
    return operationGone(operation.submittedAt, now) ? closeAfterTimeout(deps, operation) : false;
  }
  if (!(await deps.operations.close(operation.id))) return false;
  if (step === "cancel_stopped") await afterStopped(deps, operation, read?.state === "waiting" && read.started);
  else if (step === "cancel_held") await afterHeld(deps, operation);
  else await afterTimeout(deps, operation);
  return true;
}

async function closeAfterTimeout(deps: LinkedInSettleDeps, operation: OpenLinkedInOperation): Promise<boolean> {
  if (!(await deps.operations.close(operation.id))) return false;
  await afterTimeout(deps, operation);
  return true;
}

/**
 * Work that must finish before the row closes, because nothing else would pick it up, is tried again each tick. After a day it
 * gives up by the action's kind, so it cannot hold the account for good.
 */
async function retryWhileOpen<T>(deps: LinkedInSettleDeps, operation: OpenLinkedInOperation, work: () => Promise<T>): Promise<{ done: T } | { closed: boolean }> {
  try {
    return { done: await work() };
  } catch (error) {
    if (!operationGone(operation.submittedAt, deps.engine.clock.now())) throw error;
    return { closed: await closeAfterTimeout(deps, operation) };
  }
}

/** The row closes before the outcome is written. A crash between the two leaves the subject to reconciling, which never sends on a guess. */
async function finish(deps: LinkedInSettleDeps, gateway: LinkedInGateway, operation: OpenLinkedInOperation, read: Exclude<Read, { state: "waiting" }>): Promise<boolean> {
  if (operation.kind === "search" && read.state === "finished" && operation.subject) {
    // Its results exist nowhere else, so the row closes in the transaction that stores them.
    const { subject, rowLimit, id } = operation;
    const written = await retryWhileOpen(deps, operation, () => recordSearchRead(deps.search, subject, read.value as SearchPage, rowLimit, id));
    return "done" in written || written.closed;
  }
  if (operation.kind === "reply_check" && read.state === "finished" && operation.subject) return finishReplyCheck(deps, gateway, operation);
  if (!(await deps.operations.close(operation.id))) return false;
  if (!operation.subject) return true;
  const { engine } = deps;
  switch (operation.kind) {
    case "invitation":
    case "message": {
      const claim = operation.subject as NonNullable<typeof operation.subject>;
      if (read.state === "failed") await handleSendError(engine, claim, read.error);
      else if (operation.kind === "invitation") await engine.store.markSent(claim, { providerMessageId: (read.value as { invitationId: string | null }).invitationId, chatId: null }, engine.clock.now());
      else {
        const sent = read.value as { chat: string | null; messageId: string | null };
        await engine.store.markSent(claim, { providerMessageId: sent.messageId, chatId: sent.chat }, engine.clock.now());
      }
      return true;
    }
    case "lookup":
      await finishLookup(deps, operation, read as Exclude<OperationProgress<"lookup">, { state: "waiting" }>);
      return true;
    case "search": {
      const claim = operation.subject;
      const { error } = read as { error: LinkedInGatewayError };
      // A refusal read nobody. Anything else may have read, so the allowance stays charged.
      if (error.kind === "definite") await deps.search.store.returnAllowance(claim, operation.rowLimit, engine.clock.now());
      await handleSearchError(deps.search, claim, error);
      return true;
    }
    case "reply_check":
      await handleReplyCheckError(engine, operation.subject, (read as { error: LinkedInGatewayError }).error);
      return true;
  }
}

/**
 * Files what the person wrote before the row closes, so a thread that cannot be read yet is asked again. A reply that could not be
 * filed must not count as checked: the lead would stay live and get the next message. It waits, and the replay or a person takes it.
 */
async function finishReplyCheck(deps: LinkedInSettleDeps, gateway: LinkedInGateway, operation: Extract<OpenLinkedInOperation, { kind: "reply_check" }>): Promise<boolean> {
  const { engine } = deps;
  const claim = operation.subject as NonNullable<typeof operation.subject>;
  const filed = await retryWhileOpen(deps, operation, async () => {
    const deliveries = await gateway.operations!.readThread({ account: operation.providerAccountRef, to: claim.to, since: claim.since });
    const results = [];
    for (const payload of deliveries) results.push(await receiveLinkedInWebhook(deps.inbound, { organizationId: claim.organizationId, provider: operation.provider, payload }));
    return results.every((result) => result.status === "done" || result.status === "skipped" || result.status === "duplicate");
  });
  if (!("done" in filed)) return filed.closed;
  if (!(await deps.operations.close(operation.id))) return false;
  if (filed.done) await engine.store.markReplyChecked(claim.enrollmentId, operation.submittedAt);
  else await engine.store.deferReplyCheck(claim.enrollmentId, new Date(engine.clock.now().getTime() + REPLY_CHECK_RETRY_MINUTES * 60_000));
  return true;
}

async function finishLookup(deps: LinkedInSettleDeps, operation: Extract<OpenLinkedInOperation, { kind: "lookup" }>, read: Exclude<OperationProgress<"lookup">, { state: "waiting" }>): Promise<void> {
  const { engine } = deps;
  const claim = operation.subject as NonNullable<typeof operation.subject>;
  const lookup = lookupInput(claim.identifier);
  if (read.state === "finished") {
    if ("lookAgain" in read.value) await engine.store.resolveBySlug(claim, read.value.lookAgain, engine.clock.now());
    else await writeLookup(engine, claim, read.value, lookup?.memberId);
    return;
  }
  // Settle never starts the next lookup itself, which would pass the claim's gates: it stores the step, and a claim takes it.
  if (operation.api === null && lookup?.linkedinApi && fallsBackToApi(read.error)) {
    await engine.store.moveResolveToApi(claim, lookup.linkedinApi, engine.clock.now());
    return;
  }
  if (operation.api !== null && read.error.code === "insufficient_privileges") {
    await lookupWithoutAccess(engine, claim);
    return;
  }
  await handleLookupError(engine, claim, read.error);
}

/**
 * A confirmed cancel of something nobody wants any more. One that had started may have done its work: a message then waits for a
 * person, because giving it back could send it again, and a read stays charged. An invitation goes back, since LinkedIn answers a repeat as a duplicate.
 */
async function afterStopped(deps: LinkedInSettleDeps, operation: OpenLinkedInOperation, started: boolean): Promise<void> {
  if (!operation.subject) return;
  const { engine } = deps;
  if (operation.kind === "message" && started) {
    await engine.store.markUnknown(operation.subject, "This message was stopped while it was going out, so it may have gone. Check the chat and settle it.");
  } else if (operation.kind === "invitation" || operation.kind === "message") {
    const reason = await engine.store.checkBlockers(operation.subject);
    await engine.store.abandon(operation.subject, reason ?? "enrollment_stopped", engine.clock.now());
  } else if (operation.kind === "search") {
    if (!started) await deps.search.store.returnAllowance(operation.subject, operation.rowLimit, engine.clock.now());
    await deps.search.store.release(operation.subject, { error: null, retryAt: null, unknownFailure: false });
  }
}

/** A confirmed cancel of something the vendor held for its working hours. Nothing started, so everything goes back, and the account waits. */
async function afterHeld(deps: LinkedInSettleDeps, operation: OpenLinkedInOperation): Promise<void> {
  const { engine } = deps;
  const until = new Date(engine.clock.now().getTime() + OPERATION_HELD_PAUSE_MINUTES * 60_000);
  if (!operation.subject) return;
  if (operation.kind === "invitation" || operation.kind === "message") await engine.store.pauseAccountForLimit(operation.subject, until);
  else if (operation.kind === "search") {
    await deps.search.store.returnAllowance(operation.subject, operation.rowLimit, engine.clock.now());
    await deps.search.store.pauseAccountForLimit(operation.subject, until);
  } else await engine.store.pauseAccountForLookupLimit(operation.subject, until);
}

/** It ran too long, or the vendor stopped answering about it. What it may have done decides. */
async function afterTimeout(deps: LinkedInSettleDeps, operation: OpenLinkedInOperation): Promise<void> {
  if (!operation.subject) return;
  const { engine } = deps;
  const now = engine.clock.now();
  switch (operation.kind) {
    case "invitation":
      // Counts an attempt, so a lead that keeps timing out ends. LinkedIn answers a repeat as a duplicate.
      await engine.store.markFailed(operation.subject, NOTHING_NEW, now, inviteRetryMinutes(operation.subject.attempt), MAX_SEND_ATTEMPTS, false);
      return;
    case "message":
      await engine.store.markUnknown(operation.subject, "The LinkedIn provider never said whether this message went out. Check the chat and settle it.");
      return;
    case "lookup":
      await engine.store.markResolveFailed(operation.subject, NOTHING_NEW, now, false);
      return;
    case "search":
      await handleSearchError(deps.search, operation.subject, new LinkedInGatewayError(NOTHING_NEW, "unknown", "unavailable"));
      return;
    case "reply_check":
      await engine.store.deferReplyCheck(operation.subject.enrollmentId, new Date(now.getTime() + REPLY_CHECK_RETRY_MINUTES * 60_000));
      return;
  }
}
