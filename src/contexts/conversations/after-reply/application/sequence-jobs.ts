import type { Job } from "@/platform/jobs/types";
import { assertStepsBelongToVersion, draftRetryDelayMs, interruptReason, MAX_DRAFT_ATTEMPTS, renderTemplate, stepGuidance } from "../domain/sequences";
import { produceDraft, draftCitations } from "../../ai/application/ai-jobs";
import { AiError } from "@/contexts/ai/domain/ai-error";
import type { ReplyAiResolver } from "../../ai/application/ai-ports";
import type { ReplyStore } from "../../application/reply-ports";
import type { ClaimedStep, LinkOutcome, RunStore, SequenceEngineStore } from "./sequence-ports";
import { startRun } from "./sequences";

export interface SequenceJobDeps {
  engine: SequenceEngineStore;
  runs: RunStore;
  replies: ReplyStore;
  ai: ReplyAiResolver;
  now: () => Date;
  workerId: string;
  /** A step drafting for longer than this is taken over. */
  leaseMs: number;
  /** Delay before a step of an organization without AI is looked at again. */
  notConfiguredDelayMs: number;
}

export const SEQUENCE_LEASE_MS = 10 * 60_000;
const START_BATCH = 50;
const SWEEP_PAGE = 200;
const DEFER_MS = 10 * 60_000;

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 1000);

/** The counter for a link: the path's own name when it linked, else why the link came too late. */
const linkCount = (outcome: LinkOutcome, linked: string) => (outcome === "linked" ? linked : outcome === "stopped" ? "stopped_while_drafting" : "claim_lost");

/** Opens a run for every record that has a newly classified reply and a sequence to follow. */
async function startRuns(deps: SequenceJobDeps, deadline: number, count: (key: string) => void): Promise<number> {
  const candidates = await deps.engine.startCandidates(START_BATCH);
  let started = 0;
  for (const candidate of candidates) {
    if (Date.now() >= deadline) break;
    try {
      const result = await startRun(deps, { organizationId: candidate.organizationId, recordId: candidate.recordId, source: "ai_assignment" });
      if (result?.created) {
        started += 1;
        count("started");
      }
    } catch (error) {
      count("start_failed");
      console.error(`Sequence run could not start for record ${candidate.recordId}: ${errorMessage(error)}`);
    }
  }
  return started;
}

/** Stops every active or paused run that a reply, DNC, suppression, bounce or terminal stage has outdated. */
async function sweepInterruptions(deps: SequenceJobDeps, deadline: number, count: (key: string) => void): Promise<number> {
  let cursor: string | null = null;
  let stopped = 0;
  while (Date.now() < deadline) {
    const page = await deps.engine.interruptCandidates(cursor, SWEEP_PAGE);
    for (const candidate of page) {
      const reason = interruptReason(candidate.facts);
      if (!reason) continue;
      await deps.engine.interrupt(candidate.organizationId, candidate.runId, reason, deps.now());
      count(`interrupted_${reason}`);
      stopped += 1;
    }
    if (page.length < SWEEP_PAGE) break;
    cursor = page[page.length - 1].runId;
  }
  return stopped;
}

/** Writes the follow-up draft for one claimed step. The draft waits for a person; this function has no mailer. */
async function draftStep(deps: SequenceJobDeps, claim: ClaimedStep, count: (key: string) => void): Promise<void> {
  const now = deps.now();
  const org = claim.organizationId;
  // The step must belong to the version the run is pinned to. SQL checks each key alone.
  assertStepsBelongToVersion([claim.step], claim.run.sequenceVersionId);

  // A step that was claimed after a trigger arrived must not draft. The sweep usually got there first.
  const facts = await deps.engine.interruptFactsFor(org, claim.run.id);
  if (!facts) {
    // The run ended after the claim (a stop committed first). Its steps are cancelled; nothing to draft.
    count("run_ended");
    return;
  }
  const reason = interruptReason(facts);
  if (reason) {
    await deps.engine.interrupt(org, claim.run.id, reason, now);
    count(`interrupted_${reason}`);
    return;
  }

  // A draft a crash left unlinked is linked, not written twice.
  const orphan = await deps.engine.orphanDraft(org, claim.stepRunId);
  if (orphan) {
    count(linkCount(await deps.engine.linkDraft(claim, orphan, now), "relinked"));
    return;
  }

  const open = await deps.engine.openDrafts(org, claim.run.recordId);
  if (claim.step.position === 1) {
    // The reply step adopts the draft the classification already queued, so the reviewer sees one.
    const adoptable = open.find((d) => d.replyForMessageId === claim.run.triggerMessageId);
    if (adoptable) {
      count(linkCount(await deps.engine.linkDraft(claim, adoptable.id, now), "adopted"));
      return;
    }
  }
  if (open.length > 0) {
    // Someone is already reviewing or writing a draft for this record. Writing another would replace it.
    await deps.engine.release(claim, new Date(now.getTime() + DEFER_MS), now);
    count("deferred");
    return;
  }

  const provider = await deps.ai.forOrganization(org);
  if (!provider) {
    await deps.engine.release(claim, new Date(now.getTime() + deps.notConfiguredDelayMs), now);
    count("not_configured");
    return;
  }

  const ctx = await deps.replies.draftContext(org, claim.run.conversationId);
  if (!ctx) {
    await deps.engine.failAttempt(claim, "Sequence drafts need an email conversation.", null, now);
    count("failed");
    return;
  }
  const vars = { firstName: ctx.person.name?.split(/\s+/)[0] ?? "", name: ctx.person.name ?? "", company: ctx.person.company ?? "", title: ctx.person.title ?? "", email: ctx.person.email ?? "" };
  const tagged = claim.step.knowledgeTags.length > 0 ? await deps.engine.knowledgeForTags(org, claim.step.knowledgeTags) : null;
  const guided = {
    ...ctx,
    operatorInstructions: [ctx.operatorInstructions, stepGuidance(claim.step, vars)].filter(Boolean).join("\n\n"),
    knowledge: tagged && tagged.length > 0 ? tagged : ctx.knowledge,
  };
  const result = await produceDraft(provider, guided);
  const subject = claim.step.subjectTemplate ? renderTemplate(claim.step.subjectTemplate, vars).trim() || result.output.subject : result.output.subject;

  const created = await deps.engine.writeDraft(claim, {
    organizationId: org,
    recordId: ctx.recordId,
    conversationId: ctx.conversationId,
    replyForMessageId: ctx.replyForMessageId,
    expectedContextVersion: ctx.contextVersion,
    // Without it the store defaults to email, which is wrong on a LinkedIn conversation.
    channel: ctx.channel,
    subject,
    bodyText: result.output.bodyText,
    provider: provider.name,
    model: provider.model,
    request: { sequenceStepRunId: claim.stepRunId, sequenceRunId: claim.run.id, stepPosition: claim.step.position, knowledge: guided.knowledge.map((k) => k.documentVersionId) },
    response: { usage: result.usage ?? null },
    citations: draftCitations(guided),
  });
  if (!created) {
    // A stop or a pause ended the claim while the model wrote, or another claim took the step over. Nothing is written.
    count("claim_lost");
    return;
  }
  // A stop, a pause or a takeover between the write and the link: the link retires the draft unless the claim that took
  // the step over adopts it.
  count(linkCount(await deps.engine.linkDraft(claim, created.id, deps.now()), "drafted"));
}

/**
 * One tick: start runs for fresh replies, stop runs a trigger outdated, settle steps whose draft was sent or
 * discarded, then draft the steps that came due. The only thing written for a person to send is a draft.
 */
export function createSequenceJobs(deps: SequenceJobDeps): Job[] {
  return [
    {
      name: "conversations.sequences",
      async run(ctx) {
        const detail: Record<string, number> = {};
        const count = (key: string) => (detail[key] = (detail[key] ?? 0) + 1);
        let processed = 0;

        // Triggers first, so a run a reply just ended never reaches the claim below.
        processed += await sweepInterruptions(deps, ctx.deadline, count);
        processed += await startRuns(deps, ctx.deadline, count);
        processed += await deps.engine.settleDrafts(deps.now(), 200);

        while (Date.now() < ctx.deadline) {
          const claim = await deps.engine.claimDue(deps.workerId, deps.now(), deps.leaseMs);
          if (!claim) break;
          try {
            await draftStep(deps, claim, count);
            processed += 1;
          } catch (error) {
            const permanent = error instanceof AiError && error.kind === "permanent";
            const final = permanent || claim.attempts >= MAX_DRAFT_ATTEMPTS;
            await deps.engine.failAttempt(claim, errorMessage(error), final ? null : new Date(deps.now().getTime() + draftRetryDelayMs(claim.attempts)), deps.now());
            count(final ? "failed" : "retry");
          }
        }
        return { processed, more: false, detail };
      },
    },
  ];
}
