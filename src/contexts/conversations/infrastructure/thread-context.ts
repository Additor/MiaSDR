import { createHash } from "node:crypto";
import { and, desc, eq, gt, sql } from "drizzle-orm";
import { db } from "@/platform/db/client";
import {
  classifications,
  conversations,
  events,
  knowledgeDocuments,
  knowledgeDocumentVersions,
  linkedinAccounts,
  mailboxes,
  messages,
  pipelineSettings,
  records,
  subcategories,
  type AiInstructionBlock,
} from "@/platform/db/schema";
import type { DraftContext } from "../application/reply-ports";
import type { AiPersonContext, StageChange, ThreadEntry } from "../ai/domain/ai-contract";
import { KNOWLEDGE_BUDGET_CHARS, normalizeTags, selectKnowledge } from "../ai/domain/knowledge";
import { replySubject } from "../domain/reply-policy";
import { drizzleInboxStore } from "./drizzle-inbox-store";
import { publicConversation } from "@/platform/db/conversation-visibility";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Reads for prompts. Shared by the job store and the reply store so both build the same context. */

export const renderInstructions = (blocks: AiInstructionBlock[] | null | undefined): string =>
  (blocks ?? [])
    .map((b) => `## ${b.title}\n${b.content}`)
    .join("\n\n")
    .slice(0, 20_000);

/** Most candidate documents read for one prompt. */
const KNOWLEDGE_CANDIDATES = 200;

/**
 * Latest version of each active document, chosen by `selectKnowledge`: capped always-included documents first, then
 * documents ranked by tag overlap with `stepTags`, inside one character budget. `includeUnmatched` (default true)
 * lets documents without a matching tag fill the rest, as before tags existed. A tagged sequence step passes false.
 */
export async function knowledgeFor(organizationId: string, options: { alwaysOnly: boolean; stepTags?: readonly string[]; includeUnmatched?: boolean }) {
  // Stored tags are lowercase and trimmed, so the step's tags get the same treatment before the SQL compares them.
  const wantedTags = normalizeTags(options.stepTags ?? []);
  const tagList = wantedTags.length > 0 ? sql`${sql.raw("ARRAY[")}${sql.join(wantedTags.map((t) => sql`${t}`), sql`, `)}${sql.raw("]::text[]")}` : null;
  const rows = await db
    .select({
      documentVersionId: knowledgeDocumentVersions.id,
      title: knowledgeDocuments.title,
      // One character past the budget is enough to tell that the text was cut.
      content: sql<string>`left(${knowledgeDocumentVersions.content}, ${KNOWLEDGE_BUDGET_CHARS + 1})`,
      alwaysInclude: knowledgeDocuments.alwaysInclude,
      tags: knowledgeDocuments.tags,
    })
    .from(knowledgeDocuments)
    .innerJoin(
      knowledgeDocumentVersions,
      and(eq(knowledgeDocumentVersions.documentId, knowledgeDocuments.id), eq(knowledgeDocumentVersions.version, knowledgeDocuments.latestVersion)),
    )
    .where(
      and(
        eq(knowledgeDocuments.organizationId, organizationId),
        eq(knowledgeDocuments.active, true),
        options.alwaysOnly ? eq(knowledgeDocuments.alwaysInclude, true) : sql`true`,
        // A tagged step with no fallback reads only matching documents, so the candidate limit cannot cut them off.
        tagList && options.includeUnmatched === false ? sql`(${knowledgeDocuments.alwaysInclude} or ${knowledgeDocuments.tags} && ${tagList})` : sql`true`,
      ),
    )
    // Best tag matches come before the limit applies, so a match late in the alphabet still reaches `selectKnowledge`.
    .orderBy(
      desc(knowledgeDocuments.alwaysInclude),
      ...(tagList ? [sql`(select count(*) from unnest(${knowledgeDocuments.tags}) as t where t = any(${tagList})) desc`] : []),
      knowledgeDocuments.title,
    )
    .limit(KNOWLEDGE_CANDIDATES);
  return selectKnowledge(rows, { alwaysOnly: options.alwaysOnly, stepTags: options.stepTags, includeUnmatched: options.includeUnmatched ?? true });
}

export const excerptHash = (excerpt: string) => createHash("sha256").update(excerpt).digest("hex").slice(0, 32);

export async function threadEntries(organizationId: string, conversationId: string): Promise<{ person: AiPersonContext; entries: ThreadEntry[]; channel: string; accountRef: string } | null> {
  const thread = await drizzleInboxStore.thread(organizationId, conversationId);
  if (!thread) return null;
  return {
    person: { name: thread.person.name, email: thread.person.email, title: thread.person.title, company: thread.person.company },
    channel: thread.channel,
    accountRef: thread.accountRef,
    entries: thread.messages.map((m) => ({ direction: m.direction, at: m.at, subject: m.subject, text: m.bodyText })),
  };
}

/**
 * The newest `stage.moved` event written after the record's latest inbound message arrived: where a person moved
 * it, when it happened and what they wrote. Null when there is none. A move before the last inbound is history.
 */
export async function stageChangeFor(organizationId: string, recordId: string, latestInboundMessageId: string | null): Promise<StageChange | null> {
  const [inbound] = latestInboundMessageId ? await db.select({ at: messages.createdAt }).from(messages).where(eq(messages.id, latestInboundMessageId)) : [];
  const [moved] = await db
    .select({ toData: events.toData, meta: events.meta, createdAt: events.createdAt })
    .from(events)
    .where(and(eq(events.organizationId, organizationId), eq(events.recordId, recordId), eq(events.eventType, "stage.moved"), inbound ? gt(events.createdAt, inbound.at) : sql`true`))
    .orderBy(desc(events.createdAt))
    .limit(1);
  if (!moved) return null;
  const to = (moved.toData ?? {}) as { categoryKey?: string | null; subcategoryId?: string | null };
  const [sub] = to.subcategoryId ? await db.select({ name: subcategories.name }).from(subcategories).where(eq(subcategories.id, to.subcategoryId)) : [];
  const meta = moved.meta as { note?: unknown; occurredAt?: unknown };
  const occurred = typeof meta.occurredAt === "string" ? new Date(meta.occurredAt) : moved.createdAt;
  return {
    stage: sub?.name ?? to.categoryKey ?? "another stage",
    occurredAt: Number.isNaN(occurred.getTime()) ? moved.createdAt : occurred,
    note: typeof meta.note === "string" && meta.note.trim() !== "" ? meta.note : null,
  };
}

/** Prompt context for a reply to the record's latest inbound message, on email or LinkedIn. Null when the conversation is missing or on another channel. */
export async function buildDraftContext(organizationId: string, conversationId: string): Promise<DraftContext | null> {
  const [head] = await db
    .select({
      recordId: records.id,
      pipelineId: records.pipelineId,
      contextVersion: records.contextVersion,
      latestInbound: records.latestInboundMessageId,
      channel: conversations.channel,
      accountRef: conversations.accountRef,
    })
    .from(conversations)
    .innerJoin(records, eq(records.id, conversations.recordId))
    .where(and(eq(conversations.organizationId, organizationId), eq(conversations.id, conversationId), publicConversation));
  if (!head || (head.channel !== "email" && head.channel !== "linkedin")) return null;
  const channel = head.channel;
  const thread = await threadEntries(organizationId, conversationId);
  if (!thread) return null;

  const [settings] = await db.select({ draft: pipelineSettings.draftInstructions }).from(pipelineSettings).where(eq(pipelineSettings.pipelineId, head.pipelineId));
  // The name the reply goes out under: the mailbox's display name, or the connected LinkedIn account's name.
  const senderName =
    channel === "email"
      ? ((await db.select({ displayName: mailboxes.displayName }).from(mailboxes).where(and(eq(mailboxes.organizationId, organizationId), sql`lower(${mailboxes.emailAddress}) = ${head.accountRef}`)))[0]?.displayName ?? null)
      : UUID.test(head.accountRef)
        ? ((await db.select({ name: linkedinAccounts.name }).from(linkedinAccounts).where(and(eq(linkedinAccounts.organizationId, organizationId), eq(linkedinAccounts.id, head.accountRef))))[0]?.name ?? null)
        : null;

  let classification: DraftContext["classification"] = null;
  if (head.latestInbound) {
    const [row] = await db
      .select({
        id: classifications.id,
        name: subcategories.name,
        reasoning: classifications.reasoning,
      })
      .from(classifications)
      .innerJoin(subcategories, eq(subcategories.id, sql`coalesce(${classifications.appliedSubcategoryId}, ${classifications.proposedSubcategoryId})`))
      .where(and(eq(classifications.recordId, head.recordId), eq(classifications.messageId, head.latestInbound), sql`${classifications.status} in ('auto_applied', 'accepted', 'overridden', 'proposed')`))
      .orderBy(desc(classifications.createdAt))
      .limit(1);
    if (row) classification = { id: row.id, subcategoryName: row.name, reason: row.reasoning };
  }

  const lastInbound = [...thread.entries].reverse().find((e) => e.direction === "inbound" && e.subject);
  return {
    channel,
    organizationId,
    recordId: head.recordId,
    conversationId,
    contextVersion: head.contextVersion,
    replyForMessageId: head.latestInbound,
    person: thread.person,
    thread: thread.entries,
    // A chat message has no subject.
    subject: channel === "linkedin" ? "" : replySubject(lastInbound?.subject),
    classification,
    stageChange: await stageChangeFor(organizationId, head.recordId, head.latestInbound),
    operatorInstructions: renderInstructions(settings?.draft),
    knowledge: await knowledgeFor(organizationId, { alwaysOnly: false }),
    senderName,
  };
}
