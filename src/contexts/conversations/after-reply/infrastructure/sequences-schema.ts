import { sql } from "drizzle-orm";
import { check, foreignKey, index, integer, pgTable, text, unique, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { campaigns } from "@/contexts/outreach/infrastructure/schema";
import { createdAt, orgId, pk, tstz, updatedAt } from "@/platform/db/columns";
import { conversations, drafts, messages, records, subcategories } from "../../infrastructure/schema";

/**
 * Follow-up sequences. A sequence has versions; a run pins the version it
 * started on. Follow-up drafts still go through the normal draft, human
 * approval and send_attempts path. Nothing here sends.
 *
 * No `draft_version_id` / `latest_published_version_id`
 * pointers on the sequence (the "one draft" and "highest published" facts come
 * from the versions table), so no circular foreign keys.
 *
 * A campaign owns at most one sequence: its "After a reply" flow (`campaign_id` set). Sequences without a
 * campaign are the legacy standalone ones, kept as archived rows. Deleting a campaign deletes its sequence
 * with the versions and steps; the RESTRICT keys from runs block that when any run exists.
 */

const inList = (column: unknown, values: readonly string[]) =>
  sql`${column} in (${sql.raw(values.map((v) => `'${v.replace(/'/g, "''")}'`).join(", "))})`;

export const SEQUENCE_STATUSES = ["active", "archived"] as const;
export const SEQUENCE_RUN_STATUSES = ["active", "interrupted", "paused", "completed", "cancelled"] as const;
export const STEP_RUN_STATUSES = ["scheduled", "drafting", "awaiting_review", "sent", "skipped", "cancelled", "failed"] as const;

export const sequences = pgTable(
  "sequences",
  {
    id: pk(),
    organizationId: orgId(),
    name: text("name").notNull(),
    description: text("description"),
    status: text("status").notNull().default("active"),
    /** The campaign this sequence belongs to, or null for a legacy standalone sequence. */
    campaignId: uuid("campaign_id"),
    /** When the After a reply setting last turned on. Only the flow save writes it. The engine's "new reply" cutoff reads it. */
    afterReplyEnabledAt: tstz("after_reply_enabled_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({ columns: [t.campaignId, t.organizationId], foreignColumns: [campaigns.id, campaigns.organizationId] }).onDelete("cascade"),
    uniqueIndex("sequences_org_name_uq").on(t.organizationId, t.name).where(sql`${t.campaignId} is null`),
    uniqueIndex("sequences_campaign_uq").on(t.campaignId).where(sql`${t.campaignId} is not null`),
    unique("sequences_id_org_uq").on(t.id, t.organizationId),
    check("sequences_name_ck", sql`length(btrim(${t.name})) > 0`),
    check("sequences_status_ck", inList(t.status, SEQUENCE_STATUSES)),
    index("sequences_org_status_idx").on(t.organizationId, t.status, t.name),
  ],
);

export const sequenceVersions = pgTable(
  "sequence_versions",
  {
    id: pk(),
    organizationId: orgId(),
    sequenceId: uuid("sequence_id").notNull(),
    version: integer("version").notNull(),
    status: text("status").notNull().default("draft"),
    publishedAt: tstz("published_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({ columns: [t.sequenceId, t.organizationId], foreignColumns: [sequences.id, sequences.organizationId] }).onDelete("cascade"),
    unique("sequence_versions_seq_version_uq").on(t.sequenceId, t.version),
    unique("sequence_versions_id_org_uq").on(t.id, t.organizationId),
    uniqueIndex("sequence_versions_one_draft_uq").on(t.sequenceId).where(sql`${t.status} = 'draft'`),
    check("sequence_versions_version_ck", sql`${t.version} > 0`),
    check("sequence_versions_status_ck", sql`${t.status} in ('draft', 'published')`),
    check("sequence_versions_published_ck", sql`(${t.status} = 'draft') = (${t.publishedAt} is null)`),
  ],
);

/** Step 1 is the reply to the inbound message; later steps are timed follow-ups. */
export const sequenceSteps = pgTable(
  "sequence_steps",
  {
    id: pk(),
    organizationId: orgId(),
    sequenceVersionId: uuid("sequence_version_id").notNull(),
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
    foreignKey({ columns: [t.sequenceVersionId, t.organizationId], foreignColumns: [sequenceVersions.id, sequenceVersions.organizationId] }).onDelete("cascade"),
    unique("sequence_steps_version_position_uq").on(t.sequenceVersionId, t.position),
    unique("sequence_steps_id_org_uq").on(t.id, t.organizationId),
    check("sequence_steps_name_ck", sql`length(btrim(${t.name})) > 0 and length(btrim(${t.aiInstructions})) > 0`),
    check("sequence_steps_delay_ck", sql`${t.delayMinutes} >= 0`),
    check(
      "sequence_steps_semantics_ck",
      sql`(${t.position} = 1 and ${t.stepType} = 'reply' and ${t.delayMinutes} = 0) or (${t.position} > 1 and ${t.stepType} = 'follow_up')`,
    ),
  ],
);

/** The sequence a subcategory starts by default. One per subcategory. */
export const subcategorySequenceAssignments = pgTable(
  "subcategory_sequence_assignments",
  {
    subcategoryId: uuid("subcategory_id").primaryKey(),
    organizationId: orgId(),
    sequenceId: uuid("sequence_id").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({ columns: [t.subcategoryId, t.organizationId], foreignColumns: [subcategories.id, subcategories.organizationId] }).onDelete("cascade"),
    foreignKey({ columns: [t.sequenceId, t.organizationId], foreignColumns: [sequences.id, sequences.organizationId] }).onDelete("restrict"),
    index("subcategory_sequence_assignments_sequence_idx").on(t.sequenceId),
  ],
);

/** A person's manual choice of sequence, taking precedence over the subcategory default while active. */
export const recordSequenceOverrides = pgTable(
  "record_sequence_overrides",
  {
    id: pk(),
    organizationId: orgId(),
    recordId: uuid("record_id").notNull(),
    sequenceId: uuid("sequence_id").notNull(),
    source: text("source").notNull(),
    effectiveAt: tstz("effective_at").defaultNow().notNull(),
    clearedAt: tstz("cleared_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({ columns: [t.recordId, t.organizationId], foreignColumns: [records.id, records.organizationId] }).onDelete("restrict"),
    foreignKey({ columns: [t.sequenceId, t.organizationId], foreignColumns: [sequences.id, sequences.organizationId] }).onDelete("restrict"),
    uniqueIndex("record_sequence_overrides_active_uq").on(t.recordId).where(sql`${t.clearedAt} is null`),
    index("record_sequence_overrides_record_idx").on(t.recordId),
    check("record_sequence_overrides_source_ck", sql`${t.source} in ('human', 'integration')`),
    check("record_sequence_overrides_time_ck", sql`${t.clearedAt} is null or ${t.clearedAt} >= ${t.effectiveAt}`),
  ],
);

export const sequenceRuns = pgTable(
  "sequence_runs",
  {
    id: pk(),
    organizationId: orgId(),
    recordId: uuid("record_id").notNull(),
    conversationId: uuid("conversation_id").notNull(),
    sequenceId: uuid("sequence_id").notNull(),
    sequenceVersionId: uuid("sequence_version_id").notNull(),
    subcategoryId: uuid("subcategory_id").notNull(),
    status: text("status").notNull().default("active"),
    currentStepPosition: integer("current_step_position").notNull().default(1),
    startStepPosition: integer("start_step_position").notNull().default(1),
    startedBy: text("started_by").notNull(),
    triggerMessageId: uuid("trigger_message_id").notNull(),
    lastInboundAtStart: tstz("last_inbound_at_start").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({ columns: [t.recordId, t.organizationId], foreignColumns: [records.id, records.organizationId] }).onDelete("restrict"),
    foreignKey({ columns: [t.conversationId, t.organizationId], foreignColumns: [conversations.id, conversations.organizationId] }).onDelete("restrict"),
    foreignKey({ columns: [t.sequenceId, t.organizationId], foreignColumns: [sequences.id, sequences.organizationId] }).onDelete("restrict"),
    foreignKey({ columns: [t.sequenceVersionId, t.organizationId], foreignColumns: [sequenceVersions.id, sequenceVersions.organizationId] }).onDelete("restrict"),
    foreignKey({ columns: [t.subcategoryId, t.organizationId], foreignColumns: [subcategories.id, subcategories.organizationId] }).onDelete("restrict"),
    foreignKey({ columns: [t.triggerMessageId, t.organizationId], foreignColumns: [messages.id, messages.organizationId] }).onDelete("restrict"),
    unique("sequence_runs_id_org_uq").on(t.id, t.organizationId),
    uniqueIndex("sequence_runs_one_active_uq").on(t.recordId).where(sql`${t.status} = 'active'`),
    index("sequence_runs_record_created_idx").on(t.recordId, t.createdAt),
    // The RESTRICT checks of a deleted message and a deleted conversation (migration 0027).
    index("sequence_runs_trigger_message_idx").on(t.triggerMessageId),
    index("sequence_runs_conversation_idx").on(t.conversationId),
    check("sequence_runs_status_ck", inList(t.status, SEQUENCE_RUN_STATUSES)),
    check("sequence_runs_started_by_ck", sql`${t.startedBy} in ('ai_assignment', 'human_override')`),
    check("sequence_runs_positions_ck", sql`${t.startStepPosition} > 0 and ${t.currentStepPosition} >= ${t.startStepPosition}`),
  ],
);

/** One scheduled step of one run. `draft_id` links to the draft a human must approve. */
export const sequenceStepRuns = pgTable(
  "sequence_step_runs",
  {
    id: pk(),
    organizationId: orgId(),
    sequenceRunId: uuid("sequence_run_id").notNull(),
    sequenceStepId: uuid("sequence_step_id").notNull(),
    status: text("status").notNull().default("scheduled"),
    dueAt: tstz("due_at").notNull(),
    draftId: uuid("draft_id"),
    sentMessageId: uuid("sent_message_id"),
    attemptCount: integer("attempt_count").notNull().default(0),
    lastError: text("last_error"),
    expectedContextVersion: integer("expected_context_version").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({ columns: [t.sequenceRunId, t.organizationId], foreignColumns: [sequenceRuns.id, sequenceRuns.organizationId] }).onDelete("cascade"),
    foreignKey({ columns: [t.sequenceStepId, t.organizationId], foreignColumns: [sequenceSteps.id, sequenceSteps.organizationId] }).onDelete("restrict"),
    foreignKey({ columns: [t.draftId, t.organizationId], foreignColumns: [drafts.id, drafts.organizationId] }).onDelete("restrict"),
    foreignKey({ columns: [t.sentMessageId, t.organizationId], foreignColumns: [messages.id, messages.organizationId] }).onDelete("restrict"),
    unique("sequence_step_runs_run_step_uq").on(t.sequenceRunId, t.sequenceStepId),
    uniqueIndex("sequence_step_runs_draft_uq").on(t.draftId).where(sql`${t.draftId} is not null`),
    index("sequence_step_runs_due_idx").on(t.status, t.dueAt),
    // The RESTRICT check of a deleted message (migration 0027).
    index("sequence_step_runs_sent_message_idx").on(t.sentMessageId).where(sql`${t.sentMessageId} is not null`),
    check("sequence_step_runs_status_ck", inList(t.status, STEP_RUN_STATUSES)),
    check("sequence_step_runs_attempts_ck", sql`${t.attemptCount} >= 0 and ${t.expectedContextVersion} >= 0`),
    check("sequence_step_runs_sent_ck", sql`${t.status} <> 'sent' or ${t.sentMessageId} is not null`),
  ],
);
