import { sql } from "drizzle-orm";
import { check, foreignKey, index, integer, pgTable, text, unique, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { campaigns } from "@/contexts/outreach/infrastructure/schema";
import { createdAt, orgId, pk, tstz, updatedAt } from "@/platform/db/columns";
import { threads, drafts, messages, conversations, replyTypes } from "../../infrastructure/schema";
import { inList } from "@/platform/db/sql-values";
import { FOLLOW_UP_RUN_STATUSES, FLOW_STATUSES, STEP_RUN_STATUSES, type RunStatus, type FlowStatus, type StepRunStatus } from "../domain/follow-ups";

/**
 * Follow-up flows. A sequence has versions; a run pins the version it
 * started on. Follow-up drafts still go through the normal draft, human
 * approval and send_attempts path. Nothing here sends.
 *
 * No `draft_version_id` / `latest_published_version_id`
 * pointers on the sequence (the "one draft" and "highest published" facts come
 * from the versions table), so no circular foreign keys.
 *
 * A campaign owns at most one sequence: its "Follow-ups after a reply" flow (`campaign_id` set). Sequences without a
 * campaign are the legacy standalone ones, kept as archived rows. Deleting a campaign deletes its sequence
 * with the versions and steps; the RESTRICT keys from runs block that when any run exists.
 */


export const followUpFlows = pgTable(
  "follow_up_flows",
  {
    id: pk(),
    organizationId: orgId(),
    name: text("name").notNull(),
    description: text("description"),
    status: text("status").$type<FlowStatus>().notNull().default("active"),
    /** The campaign this sequence belongs to, or null for a legacy standalone sequence. */
    campaignId: uuid("campaign_id"),
    /** When the Follow-ups after a reply setting last turned on. Only the flow save writes it. The engine's "new reply" cutoff reads it. */
    afterReplyEnabledAt: tstz("after_reply_enabled_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({ columns: [t.campaignId, t.organizationId], foreignColumns: [campaigns.id, campaigns.organizationId] }).onDelete("cascade"),
    uniqueIndex("follow_up_flows_org_name_uq").on(t.organizationId, t.name).where(sql`${t.campaignId} is null`),
    uniqueIndex("follow_up_flows_campaign_uq").on(t.campaignId).where(sql`${t.campaignId} is not null`),
    unique("follow_up_flows_id_org_uq").on(t.id, t.organizationId),
    check("follow_up_flows_name_ck", sql`length(btrim(${t.name})) > 0`),
    check("follow_up_flows_status_ck", inList(t.status, FLOW_STATUSES)),
    index("follow_up_flows_org_status_idx").on(t.organizationId, t.status, t.name),
  ],
);

export const followUpVersions = pgTable(
  "follow_up_versions",
  {
    id: pk(),
    organizationId: orgId(),
    flowId: uuid("flow_id").notNull(),
    version: integer("version").notNull(),
    status: text("status").notNull().default("draft"),
    publishedAt: tstz("published_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({ columns: [t.flowId, t.organizationId], foreignColumns: [followUpFlows.id, followUpFlows.organizationId] }).onDelete("cascade"),
    unique("follow_up_versions_seq_version_uq").on(t.flowId, t.version),
    unique("follow_up_versions_id_org_uq").on(t.id, t.organizationId),
    uniqueIndex("follow_up_versions_one_draft_uq").on(t.flowId).where(sql`${t.status} = 'draft'`),
    check("follow_up_versions_version_ck", sql`${t.version} > 0`),
    check("follow_up_versions_status_ck", sql`${t.status} in ('draft', 'published')`),
    check("follow_up_versions_published_ck", sql`(${t.status} = 'draft') = (${t.publishedAt} is null)`),
  ],
);

/** Step 1 is the reply to the inbound message; later steps are timed follow-ups. */
export const followUpSteps = pgTable(
  "follow_up_steps",
  {
    id: pk(),
    organizationId: orgId(),
    followUpVersionId: uuid("follow_up_version_id").notNull(),
    position: integer("position").notNull(),
    stepType: text("step_type").notNull(),
    name: text("name").notNull(),
    delayMinutes: integer("delay_minutes").notNull(),
    subjectTemplate: text("subject_template"),
    bodyTemplate: text("body_template"),
    aiInstructions: text("ai_instructions").notNull(),
    knowledgeTags: text("knowledge_tags").array().default(sql`'{}'::text[]`).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({ columns: [t.followUpVersionId, t.organizationId], foreignColumns: [followUpVersions.id, followUpVersions.organizationId] }).onDelete("cascade"),
    unique("follow_up_steps_version_position_uq").on(t.followUpVersionId, t.position),
    unique("follow_up_steps_id_org_uq").on(t.id, t.organizationId),
    check("follow_up_steps_name_ck", sql`length(btrim(${t.name})) > 0 and length(btrim(${t.aiInstructions})) > 0`),
    check("follow_up_steps_delay_ck", sql`${t.delayMinutes} >= 0`),
    check(
      "follow_up_steps_semantics_ck",
      sql`(${t.position} = 1 and ${t.stepType} = 'reply' and ${t.delayMinutes} = 0) or (${t.position} > 1 and ${t.stepType} = 'follow_up')`,
    ),
  ],
);

export const followUpRuns = pgTable(
  "follow_up_runs",
  {
    id: pk(),
    organizationId: orgId(),
    conversationId: uuid("conversation_id").notNull(),
    threadId: uuid("thread_id").notNull(),
    flowId: uuid("flow_id").notNull(),
    followUpVersionId: uuid("follow_up_version_id").notNull(),
    replyTypeId: uuid("reply_type_id").notNull(),
    status: text("status").$type<RunStatus>().notNull().default("active"),
    currentStepPosition: integer("current_step_position").notNull().default(1),
    startStepPosition: integer("start_step_position").notNull().default(1),
    startedBy: text("started_by").notNull(),
    triggerMessageId: uuid("trigger_message_id").notNull(),
    lastInboundAtStart: tstz("last_inbound_at_start").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({ columns: [t.conversationId, t.organizationId], foreignColumns: [conversations.id, conversations.organizationId] }).onDelete("restrict"),
    foreignKey({ columns: [t.threadId, t.organizationId], foreignColumns: [threads.id, threads.organizationId] }).onDelete("restrict"),
    foreignKey({ columns: [t.flowId, t.organizationId], foreignColumns: [followUpFlows.id, followUpFlows.organizationId] }).onDelete("restrict"),
    foreignKey({ columns: [t.followUpVersionId, t.organizationId], foreignColumns: [followUpVersions.id, followUpVersions.organizationId] }).onDelete("restrict"),
    foreignKey({ columns: [t.replyTypeId, t.organizationId], foreignColumns: [replyTypes.id, replyTypes.organizationId] }).onDelete("restrict"),
    foreignKey({ columns: [t.triggerMessageId, t.organizationId], foreignColumns: [messages.id, messages.organizationId] }).onDelete("restrict"),
    unique("follow_up_runs_id_org_uq").on(t.id, t.organizationId),
    uniqueIndex("follow_up_runs_one_active_uq").on(t.conversationId).where(sql`${t.status} = 'active'`),
    index("follow_up_runs_conversation_created_idx").on(t.conversationId, t.createdAt),
    // The RESTRICT checks of a deleted message and a deleted conversation.
    index("follow_up_runs_trigger_message_idx").on(t.triggerMessageId),
    index("follow_up_runs_thread_idx").on(t.threadId),
    check("follow_up_runs_status_ck", inList(t.status, FOLLOW_UP_RUN_STATUSES)),
    check("follow_up_runs_started_by_ck", sql`${t.startedBy} in ('ai_assignment', 'human_override')`),
    check("follow_up_runs_positions_ck", sql`${t.startStepPosition} > 0 and ${t.currentStepPosition} >= ${t.startStepPosition}`),
  ],
);

/** One scheduled step of one run. `draft_id` links to the draft a human must approve. */
export const followUpStepRuns = pgTable(
  "follow_up_step_runs",
  {
    id: pk(),
    organizationId: orgId(),
    followUpRunId: uuid("follow_up_run_id").notNull(),
    followUpStepId: uuid("follow_up_step_id").notNull(),
    status: text("status").$type<StepRunStatus>().notNull().default("scheduled"),
    dueAt: tstz("due_at").notNull(),
    draftId: uuid("draft_id"),
    sentMessageId: uuid("sent_message_id"),
    attemptCount: integer("attempt_count").notNull().default(0),
    lastError: text("last_error"),
    expectedContextVersion: integer("expected_context_version").notNull(),
    /** The token of the claim that holds the row, new on each claim. A settle that no longer holds it changes nothing. */
    claimToken: uuid("claim_token"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({ columns: [t.followUpRunId, t.organizationId], foreignColumns: [followUpRuns.id, followUpRuns.organizationId] }).onDelete("cascade"),
    foreignKey({ columns: [t.followUpStepId, t.organizationId], foreignColumns: [followUpSteps.id, followUpSteps.organizationId] }).onDelete("restrict"),
    foreignKey({ columns: [t.draftId, t.organizationId], foreignColumns: [drafts.id, drafts.organizationId] }).onDelete("restrict"),
    foreignKey({ columns: [t.sentMessageId, t.organizationId], foreignColumns: [messages.id, messages.organizationId] }).onDelete("restrict"),
    unique("follow_up_step_runs_run_step_uq").on(t.followUpRunId, t.followUpStepId),
    uniqueIndex("follow_up_step_runs_draft_uq").on(t.draftId).where(sql`${t.draftId} is not null`),
    index("follow_up_step_runs_due_idx").on(t.status, t.dueAt),
    // The RESTRICT check of a deleted message.
    index("follow_up_step_runs_sent_message_idx").on(t.sentMessageId).where(sql`${t.sentMessageId} is not null`),
    check("follow_up_step_runs_status_ck", inList(t.status, STEP_RUN_STATUSES)),
    check("follow_up_step_runs_attempts_ck", sql`${t.attemptCount} >= 0 and ${t.expectedContextVersion} >= 0`),
    check("follow_up_step_runs_sent_ck", sql`${t.status} <> 'sent' or ${t.sentMessageId} is not null`),
  ],
);
