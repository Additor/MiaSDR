import { sql } from "drizzle-orm";
import { check, date, foreignKey, index, integer, jsonb, numeric, pgTable, primaryKey, text, unique, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import type { AiUsage } from "@/contexts/ai/domain/generation";
import { knowledgeDocuments } from "@/contexts/brain/infrastructure/schema";
import { users } from "@/contexts/identity/infrastructure/schema";
import { people } from "@/contexts/people/infrastructure/schema";
import { createdAt, orgId, pk, tstz, updatedAt } from "@/platform/db/columns";
import { inList } from "@/platform/db/sql-values";
import { MIA_MESSAGE_ROLES, MIA_MESSAGE_STATUSES, type ChatPart, type MiaMessageRole, type MiaMessageStatus } from "../domain/mia-chat";
import { MIA_CAPABILITIES, MIA_RUN_STATUSES, type MiaCapability, type MiaRunStatus } from "../domain/mia-run";
import { MIA_SUGGESTION_STATUSES, MIA_SUGGESTION_TYPES, type MiaSuggestionStatus, type MiaSuggestionType, type SuggestionPayload } from "../domain/suggestion";

/** One job a person asked Mia for. A worker holds it through `claim_token`. "Mia" in docs/decisions.md. */
export const miaRuns = pgTable(
  "mia_runs",
  {
    id: pk(),
    organizationId: orgId(),
    capability: text("capability").$type<MiaCapability>().notNull(),
    status: text("status").$type<MiaRunStatus>().notNull().default("queued"),
    /** Null once that user is gone. */
    requestedBy: uuid("requested_by").references(() => users.id, { onDelete: "set null" }),
    /** What the person gave: an address, pasted text or an item id. Emptied when the run ends. */
    input: jsonb("input").$type<Record<string, unknown>>().notNull(),
    /** The conversation with the model so far and the pages read, so a restart repeats no paid call. Emptied when the run ends. */
    checkpoint: jsonb("checkpoint").$type<Record<string, unknown>>(),
    /** The lead a fit check judges. Deleting the person deletes its checks, so a running one finds its claim gone. */
    personId: uuid("person_id"),
    /** The request a fit check came in with, so a list can report the batch and stop it. */
    batchId: uuid("batch_id"),
    stepCount: integer("step_count").notNull().default(0),
    /** Tokens this run used. */
    usedTokens: integer("used_tokens").notNull().default(0),
    suggestionCount: integer("suggestion_count").notNull().default(0),
    provider: text("provider"),
    model: text("model"),
    /** Raised by each claim. With the token, it tells this claim from a later one. */
    attempts: integer("attempts").notNull().default(0),
    /** Failures since the last step that worked. */
    failures: integer("failures").notNull().default(0),
    claimToken: uuid("claim_token"),
    leaseExpiresAt: tstz("lease_expires_at"),
    nextAttemptAt: tstz("next_attempt_at").defaultNow().notNull(),
    cancelRequestedAt: tstz("cancel_requested_at"),
    failureKind: text("failure_kind"),
    /** Written for the person who started the run. Never holds page text or a key. */
    error: text("error"),
    startedAt: tstz("started_at"),
    finishedAt: tstz("finished_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("mia_runs_id_org_uq").on(t.id, t.organizationId),
    check("mia_runs_capability_ck", inList(t.capability, MIA_CAPABILITIES)),
    check("mia_runs_status_ck", inList(t.status, MIA_RUN_STATUSES)),
    check("mia_runs_input_size_ck", sql`octet_length(${t.input}::text) <= 409600`),
    check("mia_runs_checkpoint_size_ck", sql`${t.checkpoint} is null or octet_length(${t.checkpoint}::text) <= 4194304`),
    index("mia_runs_org_created_idx").on(t.organizationId, t.createdAt.desc()),
    // The worker's claim: what is due, and what a worker that died left behind.
    index("mia_runs_due_idx").on(t.nextAttemptAt).where(sql`${t.status} in ('queued', 'waiting_limit')`),
    index("mia_runs_lease_idx").on(t.leaseExpiresAt).where(sql`${t.status} = 'running'`),
    // One site or text at a time per organization, and one run per document to sort.
    uniqueIndex("mia_runs_one_fill_uq").on(t.organizationId).where(sql`${t.capability} in ('brain_fill_url', 'brain_fill_text') and ${t.status} in ('queued', 'running', 'waiting_limit')`),
    uniqueIndex("mia_runs_one_sort_uq").on(t.organizationId, sql`(${t.input}->>'itemId')`).where(sql`${t.capability} = 'brain_sort' and ${t.status} in ('queued', 'running', 'waiting_limit')`),
    // One fit check at a time per lead.
    uniqueIndex("mia_runs_one_fit_uq").on(t.organizationId, t.personId).where(sql`${t.capability} = 'lead_fit' and ${t.status} in ('queued', 'running', 'waiting_limit')`),
    index("mia_runs_org_batch_idx").on(t.organizationId, t.batchId).where(sql`${t.batchId} is not null`),
    check("mia_runs_fit_person_ck", sql`(${t.capability} = 'lead_fit') = (${t.personId} is not null and ${t.batchId} is not null)`),
    foreignKey({ name: "mia_runs_person_fk", columns: [t.personId, t.organizationId], foreignColumns: [people.id, people.organizationId] }).onDelete("cascade"),
    // Deleting a person finds its runs through this, not by reading every run.
    index("mia_runs_person_idx").on(t.personId, t.organizationId).where(sql`${t.personId} is not null`),
  ],
);

/** What Mia offers for Brain. Nothing reaches Brain until a person accepts it. */
export const miaSuggestions = pgTable(
  "mia_suggestions",
  {
    id: pk(),
    organizationId: orgId(),
    type: text("type").$type<MiaSuggestionType>().notNull(),
    status: text("status").$type<MiaSuggestionStatus>().notNull().default("open"),
    runId: uuid("run_id"),
    /** Which step of the run wrote it, and its place in that step. A retried step writes nothing twice. */
    stepCount: integer("step_count").notNull(),
    ordinal: integer("ordinal").notNull(),
    targetItemId: uuid("target_item_id"),
    kind: text("kind").notNull(),
    title: text("title").notNull(),
    payload: jsonb("payload").$type<SuggestionPayload>().notNull(),
    decidedBy: uuid("decided_by").references(() => users.id, { onDelete: "set null" }),
    decidedAt: tstz("decided_at"),
    createdItemId: uuid("created_item_id"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check("mia_suggestions_type_ck", inList(t.type, MIA_SUGGESTION_TYPES)),
    check("mia_suggestions_status_ck", inList(t.status, MIA_SUGGESTION_STATUSES)),
    check("mia_suggestions_payload_size_ck", sql`octet_length(${t.payload}::text) <= 262144`),
    check("mia_suggestions_title_ck", sql`length(${t.title}) between 1 and 200`),
    unique("mia_suggestions_step_uq").on(t.runId, t.stepCount, t.ordinal),
    // The migration writes `ON DELETE SET NULL (column)` on these three: a plain SET NULL would clear `organization_id` too.
    foreignKey({ name: "mia_suggestions_run_fk", columns: [t.runId, t.organizationId], foreignColumns: [miaRuns.id, miaRuns.organizationId] }).onDelete("set null"),
    foreignKey({ name: "mia_suggestions_target_fk", columns: [t.targetItemId, t.organizationId], foreignColumns: [knowledgeDocuments.id, knowledgeDocuments.organizationId] }).onDelete("set null"),
    foreignKey({ name: "mia_suggestions_created_item_fk", columns: [t.createdItemId, t.organizationId], foreignColumns: [knowledgeDocuments.id, knowledgeDocuments.organizationId] }).onDelete("set null"),
    index("mia_suggestions_org_status_idx").on(t.organizationId, t.status, t.createdAt.desc()),
  ],
);

/** One person's chat with Mia. Only that person sees it; a member who leaves takes their chats with them. */
export const miaThreads = pgTable(
  "mia_threads",
  {
    id: pk(),
    organizationId: orgId(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** The lead a person asked about from its page. Cleared when that person is deleted. */
    personId: uuid("person_id"),
    /** From the first question. Null until one is asked. */
    title: text("title"),
    /** The turn that is answering now. A second question waits for it, unless it has gone stale. */
    turnToken: uuid("turn_token"),
    turnStartedAt: tstz("turn_started_at"),
    lastMessageAt: tstz("last_message_at").defaultNow().notNull(),
    /** Set when a deleted person took part of the chat with them. */
    purgedAt: tstz("purged_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("mia_threads_id_org_uq").on(t.id, t.organizationId),
    check("mia_threads_title_ck", sql`${t.title} is null or length(${t.title}) between 1 and 200`),
    index("mia_threads_org_user_idx").on(t.organizationId, t.userId, t.lastMessageAt.desc()),
    // The migration writes `ON DELETE SET NULL (person_id)`: a plain SET NULL would clear `organization_id` too.
    foreignKey({ name: "mia_threads_person_fk", columns: [t.personId, t.organizationId], foreignColumns: [people.id, people.organizationId] }).onDelete("set null"),
    // Deleting a person finds the chats about them through this, not by reading every chat.
    index("mia_threads_person_idx").on(t.personId, t.organizationId).where(sql`${t.personId} is not null`),
  ],
);

/** A question or an answer. An answer keeps its text and which tools it used, never what the tools returned. */
export const miaMessages = pgTable(
  "mia_messages",
  {
    id: pk(),
    organizationId: orgId(),
    threadId: uuid("thread_id").notNull(),
    /** The question and its answer share one. */
    turnId: uuid("turn_id").notNull(),
    role: text("role").$type<MiaMessageRole>().notNull(),
    /** The browser's id for a question, so a second click sends nothing twice. */
    clientId: text("client_id"),
    status: text("status").$type<MiaMessageStatus>().notNull(),
    parts: jsonb("parts").$type<ChatPart[]>().notNull(),
    usage: jsonb("usage").$type<AiUsage>(),
    provider: text("provider"),
    model: text("model"),
    /** Written for the person who asked. Never holds a key or what a tool returned. */
    error: text("error"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check("mia_messages_role_ck", inList(t.role, MIA_MESSAGE_ROLES)),
    check("mia_messages_status_ck", inList(t.status, MIA_MESSAGE_STATUSES)),
    check("mia_messages_parts_size_ck", sql`octet_length(${t.parts}::text) <= 262144`),
    check("mia_messages_client_ck", sql`(${t.role} = 'user') = (${t.clientId} is not null)`),
    unique("mia_messages_client_uq").on(t.threadId, t.clientId),
    index("mia_messages_org_thread_idx").on(t.organizationId, t.threadId, t.createdAt, t.id),
    // Retention deletes by age, message by message.
    index("mia_messages_org_created_idx").on(t.organizationId, t.createdAt),
    foreignKey({ name: "mia_messages_thread_fk", columns: [t.threadId, t.organizationId], foreignColumns: [miaThreads.id, miaThreads.organizationId] }).onDelete("cascade"),
  ],
);

/**
 * The people a chat read. Deleting a person deletes the chat from the turn that first read them, so what Mia said about
 * them goes too. The person key has no cascade on purpose: a delete path that forgets the purge fails instead of leaving
 * a copy behind.
 */
export const miaThreadPeople = pgTable(
  "mia_thread_people",
  {
    threadId: uuid("thread_id").notNull(),
    personId: uuid("person_id").notNull(),
    organizationId: orgId(),
    /** The turn that first read this person. Null when the chat started from their page. */
    firstTurnId: uuid("first_turn_id"),
    firstLinkedAt: tstz("first_linked_at").defaultNow().notNull(),
  },
  (t) => [
    primaryKey({ name: "mia_thread_people_pk", columns: [t.threadId, t.personId] }),
    index("mia_thread_people_org_person_idx").on(t.organizationId, t.personId),
    foreignKey({ name: "mia_thread_people_thread_fk", columns: [t.threadId, t.organizationId], foreignColumns: [miaThreads.id, miaThreads.organizationId] }).onDelete("cascade"),
    foreignKey({ name: "mia_thread_people_person_fk", columns: [t.personId, t.organizationId], foreignColumns: [people.id, people.organizationId] }),
  ],
);

/** Tokens Mia used per organization and UTC day. */
export const miaUsageDaily = pgTable(
  "mia_usage_daily",
  {
    id: pk(),
    organizationId: orgId(),
    day: date("day").notNull(),
    inputTokens: integer("input_tokens").notNull().default(0),
    cacheReadTokens: integer("cache_read_tokens").notNull().default(0),
    cacheWriteTokens: integer("cache_write_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    /** Only some providers report a cost, so a sum is a lower bound. */
    costUsd: numeric("cost_usd", { precision: 12, scale: 6 }),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("mia_usage_daily_org_day_uq").on(t.organizationId, t.day)],
);
