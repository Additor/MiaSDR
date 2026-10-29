import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { users } from "@/contexts/identity/infrastructure/schema";
import { members } from "@/contexts/tenancy/infrastructure/schema";
import { people } from "@/contexts/people/infrastructure/schema";
import { campaigns } from "@/contexts/outreach/infrastructure/schema";
import { createdAt, orgId, pk, tstz, updatedAt } from "@/platform/db/columns";
import { DRAFT_STATUSES, IN_FLIGHT_DRAFT_STATUSES, type DraftStatus } from "../domain/draft-status";
import type { AttemptStatus } from "../domain/send-attempt-status";
import { WORKFLOW_STATES, type WorkflowState } from "../domain/workflow-state";
import { CHECK_MODES, FOLLOW_UPS_RULES, SYSTEM_ROLES, type CheckMode, type FollowUpsRule, type SystemRole, type TypeRules } from "../domain/reply-type";
import { inList } from "@/platform/db/sql-values";
import { AI_JOB_STATUSES, type AiJobStatus } from "../ai/domain/ai-job-status";

/**
 * Conversations: replies from every channel land in one model keyed on
 * `people`, with no second email model for the CRM. A sender we do
 * not know gets a `people` row (source `inbound`), not a second contact table.
 *
 * Nothing is sent without human approval. That rule lives in the domain and
 * in `send_attempts`; there is no setting to turn it off.
 *
 * The Follow-ups after a reply flow keeps its tables in `after-reply/infrastructure/sequences-schema.ts`.
 */

export const REPLY_TYPE_GROUP_KEYS = ["customer", "interested", "not_interested", "other"] as const;

export const replyTypeSets = pgTable(
  "reply_type_sets",
  {
    id: pk(),
    organizationId: orgId(),
    name: text("name").notNull(),
    isDefault: boolean("is_default").notNull().default(false),
    active: boolean("active").notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("reply_type_sets_org_name_uq").on(t.organizationId, t.name),
    unique("reply_type_sets_id_org_uq").on(t.id, t.organizationId),
    uniqueIndex("reply_type_sets_one_default_uq").on(t.organizationId).where(sql`${t.isDefault}`),
    check("reply_type_sets_name_ck", sql`length(btrim(${t.name})) > 0`),
  ],
);

export const replyTypes = pgTable(
  "reply_types",
  {
    id: pk(),
    organizationId: orgId(),
    replyTypeSetId: uuid("reply_type_set_id").notNull(),
    groupKey: text("group_key").notNull(),
    key: text("key").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    classificationGuidance: text("classification_guidance"),
    active: boolean("active").notNull().default(true),
    sortOrder: integer("sort_order").notNull().default(0),
    /** Type rules (`domain/reply-type.ts`): who checks the AI's pick, whether it drafts a reply, whether follow-ups go on. */
    checkMode: text("check_mode").$type<CheckMode>().notNull().default("after"),
    replyDraft: boolean("reply_draft").notNull().default(true),
    followUps: text("follow_ups").$type<FollowUpsRule>().notNull().default("continue"),
    /** A fixed path this type drives. At most one type per role in a set, and it never changes. */
    systemRole: text("system_role").$type<SystemRole>(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({ columns: [t.replyTypeSetId, t.organizationId], foreignColumns: [replyTypeSets.id, replyTypeSets.organizationId] }).onDelete("restrict"),
    unique("reply_types_set_key_uq").on(t.replyTypeSetId, t.key),
    // Target of the record's composite FK: a subcategory must belong to the record's pipeline and category.
    unique("reply_types_id_set_group_uq").on(t.id, t.replyTypeSetId, t.groupKey),
    unique("reply_types_id_org_uq").on(t.id, t.organizationId),
    check("reply_types_group_ck", inList(t.groupKey, REPLY_TYPE_GROUP_KEYS)),
    check("reply_types_key_ck", sql`${t.key} ~ '^[a-z][a-z0-9_]*$'`),
    check("reply_types_sort_ck", sql`${t.sortOrder} >= 0`),
    check("reply_types_rules_ck", sql`${inList(t.checkMode, CHECK_MODES)} and ${inList(t.followUps, FOLLOW_UPS_RULES)}`),
    check("reply_types_system_role_ck", sql`${t.systemRole} is null or ${inList(t.systemRole, SYSTEM_ROLES)}`),
    // The stop request type keeps STOP_REQUEST_RULES and stays active; the customer type stays in the customer group.
    check(
      "reply_types_stop_request_ck",
      sql`${t.systemRole} is distinct from 'stop_request' or (${t.checkMode} = 'before' and not ${t.replyDraft} and ${t.followUps} = 'stop' and ${t.active})`,
    ),
    check("reply_types_customer_ck", sql`${t.systemRole} is distinct from 'customer' or ${t.groupKey} = 'customer'`),
    uniqueIndex("reply_types_set_system_role_uq").on(t.replyTypeSetId, t.systemRole).where(sql`${t.systemRole} is not null`),
  ],
);

export interface AiInstructionBlock {
  id: string;
  title: string;
  content: string;
}

export const replyHandlingSettings = pgTable(
  "reply_handling_settings",
  {
    replyTypeSetId: uuid("reply_type_set_id").primaryKey(),
    organizationId: orgId(),
    /** The confidence floor: an AI pick below it waits for a person, whatever its type's Check rule says. */
    autoApplyConfidence: numeric("auto_apply_confidence", { precision: 4, scale: 3 }).notNull().default("0.850"),
    draftInstructions: jsonb("draft_instructions").$type<AiInstructionBlock[]>().default([]).notNull(),
    classificationInstructions: jsonb("classification_instructions").$type<AiInstructionBlock[]>().default([]).notNull(),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({ columns: [t.replyTypeSetId, t.organizationId], foreignColumns: [replyTypeSets.id, replyTypeSets.organizationId] }).onDelete("cascade"),
    check("reply_handling_settings_confidence_ck", sql`${t.autoApplyConfidence} between 0 and 1`),
    // The API caps instructions at 20,000 characters of text; 100,000 leaves room for JSON escapes and titles.
    check(
      "reply_handling_settings_instructions_ck",
      sql`jsonb_typeof(${t.draftInstructions}) = 'array' and jsonb_typeof(${t.classificationInstructions}) = 'array'
        and length(${t.draftInstructions}::text) <= 100000 and length(${t.classificationInstructions}::text) <= 100000`,
    ),
  ],
);

export const CHANNELS = ["email", "linkedin", "whatsapp"] as const;

/** One person's standing in one pipeline. `context_version` is the optimistic lock for AI work. */
export const records = pgTable(
  "records",
  {
    id: pk(),
    organizationId: orgId(),
    personId: uuid("person_id").notNull(),
    replyTypeSetId: uuid("reply_type_set_id").notNull(),
    groupKey: text("group_key"),
    replyTypeId: uuid("reply_type_id"),
    workflowState: text("workflow_state").$type<WorkflowState>().notNull().default("unclassified"),
    replyTypeSource: text("reply_type_source"),
    replyTypeLocked: boolean("reply_type_locked").notNull().default(false),
    activeChannel: text("active_channel"),
    latestInboundMessageId: uuid("latest_inbound_message_id"),
    contextVersion: integer("context_version").notNull().default(0),
    lastInboundAt: tstz("last_inbound_at"),
    lastOutboundAt: tstz("last_outbound_at"),
    lastInteractionAt: tstz("last_interaction_at"),
    nextActionAt: tstz("next_action_at"),
    closedReason: text("closed_reason"),
    /** The member who handles the replies of this record. Null: unassigned. Not the deal's owner and not a task's assignee. */
    assignedTo: uuid("assigned_to"),
    /** How `assigned_to` was set: `auto` from the campaign creator, `human` by a person, `cleared` when a person chose Nobody. */
    assignedSource: text("assigned_source"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({ columns: [t.personId, t.organizationId], foreignColumns: [people.id, people.organizationId] }).onDelete("restrict"),
    foreignKey({ columns: [t.replyTypeSetId, t.organizationId], foreignColumns: [replyTypeSets.id, replyTypeSets.organizationId] }).onDelete("restrict"),
    // A member who leaves the organization unassigns the record. The migration writes `ON DELETE SET NULL (assigned_to)`, so
    // organization_id stays set; `assigned_source` keeps its old value and is read only while `assigned_to` is set.
    foreignKey({ name: "records_assigned_to_fk", columns: [t.organizationId, t.assignedTo], foreignColumns: [members.organizationId, members.userId] }).onDelete("set null"),
    foreignKey({
      columns: [t.replyTypeId, t.replyTypeSetId, t.groupKey],
      foreignColumns: [replyTypes.id, replyTypes.replyTypeSetId, replyTypes.groupKey],
    }),
    // `latest_inbound_message_id -> messages (id, organization_id) ON DELETE SET NULL (latest_inbound_message_id)` lives in
    // the migration SQL only: `messages` is declared after this table through `conversations`, and a typed reference here
    // would make the three tables' types circular.
    unique("records_person_reply_type_set_uq").on(t.personId, t.replyTypeSetId),
    unique("records_id_org_uq").on(t.id, t.organizationId),
    check("records_group_ck", sql`${t.groupKey} is null or ${inList(t.groupKey, REPLY_TYPE_GROUP_KEYS)}`),
    check("records_workflow_ck", inList(t.workflowState, WORKFLOW_STATES)),
    check("records_source_ck", sql`${t.replyTypeSource} is null or ${t.replyTypeSource} in ('ai', 'human', 'integration')`),
    check("records_reply_type_source_pair_ck", sql`(${t.groupKey} is null) = (${t.replyTypeSource} is null)`),
    check("records_locked_ck", sql`not ${t.replyTypeLocked} or ${t.groupKey} = 'customer'`),
    check("records_reply_type_needs_group_ck", sql`${t.replyTypeId} is null or ${t.groupKey} is not null`),
    check("records_version_ck", sql`${t.contextVersion} >= 0`),
    check("records_active_channel_ck", sql`${t.activeChannel} is null or ${inList(t.activeChannel, CHANNELS)}`),
    check("records_assigned_source_ck", sql`(${t.assignedSource} is null or ${t.assignedSource} in ('auto', 'human', 'cleared')) and (${t.assignedTo} is null or ${t.assignedSource} is not null)`),
    index("records_org_assigned_idx").on(t.organizationId, t.assignedTo, t.workflowState),
    index("records_org_state_idx").on(t.organizationId, t.workflowState, t.lastInteractionAt),
    // A deleted message sets this column null through that key; the contact delete deletes messages.
    index("records_latest_inbound_message_idx").on(t.latestInboundMessageId).where(sql`${t.latestInboundMessageId} is not null`),
  ],
);

export const conversations = pgTable(
  "conversations",
  {
    id: pk(),
    organizationId: orgId(),
    recordId: uuid("record_id").notNull(),
    channel: text("channel").notNull(),
    /** Mailbox address, LinkedIn account id. By value, so conversations do not depend on the outreach schema. */
    accountRef: text("account_ref").notNull(),
    providerThreadId: text("provider_thread_id"),
    providerContactId: text("provider_contact_id"),
    status: text("status").notNull().default("active"),
    /** Set when the thread belongs to a personal campaign. Such a conversation is hidden from every inbox read (conversation-visibility.ts). */
    privateCampaignId: uuid("private_campaign_id"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({ columns: [t.recordId, t.organizationId], foreignColumns: [records.id, records.organizationId] }).onDelete("restrict"),
    foreignKey({ name: "conversations_private_campaign_fk", columns: [t.privateCampaignId, t.organizationId], foreignColumns: [campaigns.id, campaigns.organizationId] }),
    index("conversations_private_idx").on(t.organizationId, t.privateCampaignId).where(sql`${t.privateCampaignId} is not null`),
    unique("conversations_id_org_uq").on(t.id, t.organizationId),
    unique("conversations_id_channel_account_uq").on(t.id, t.channel, t.accountRef),
    uniqueIndex("conversations_thread_uq")
      .on(t.channel, t.accountRef, t.providerThreadId)
      .where(sql`${t.providerThreadId} is not null`),
    check("conversations_channel_ck", inList(t.channel, CHANNELS)),
    check("conversations_status_ck", sql`${t.status} in ('active', 'closed')`),
    check("conversations_account_ref_ck", sql`length(btrim(${t.accountRef})) > 0`),
    index("conversations_record_idx").on(t.recordId),
  ],
);

export const messages = pgTable(
  "messages",
  {
    id: pk(),
    organizationId: orgId(),
    conversationId: uuid("conversation_id").notNull(),
    channel: text("channel").notNull(),
    accountRef: text("account_ref").notNull(),
    direction: text("direction").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    providerMessageId: text("provider_message_id"),
    subject: text("subject"),
    fromAddress: text("from_address"),
    toAddress: text("to_address"),
    cc: text("cc").array(),
    bodyText: text("body_text").notNull(),
    bodyHtml: text("body_html"),
    important: boolean("important").notNull().default(false),
    openedAt: tstz("opened_at"),
    raw: jsonb("raw").$type<unknown>(),
    sentAt: tstz("sent_at").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({ columns: [t.conversationId, t.organizationId], foreignColumns: [conversations.id, conversations.organizationId] }).onDelete("restrict"),
    // Channel and account repeat the conversation's, so a message cannot disagree with its conversation.
    foreignKey({
      columns: [t.conversationId, t.channel, t.accountRef],
      foreignColumns: [conversations.id, conversations.channel, conversations.accountRef],
    }),
    unique("messages_id_org_uq").on(t.id, t.organizationId),
    unique("messages_idempotency_uq").on(t.channel, t.accountRef, t.idempotencyKey),
    uniqueIndex("messages_provider_id_uq")
      .on(t.channel, t.accountRef, t.providerMessageId)
      .where(sql`${t.providerMessageId} is not null`),
    check("messages_direction_ck", sql`${t.direction} in ('inbound', 'outbound')`),
    check("messages_body_ck", sql`length(btrim(${t.bodyText})) > 0`),
    check("messages_keys_ck", sql`length(btrim(${t.idempotencyKey})) > 0 and length(btrim(${t.accountRef})) > 0`),
    index("messages_conversation_sent_idx").on(t.conversationId, t.sentAt),
    index("messages_org_direction_sent_idx").on(t.organizationId, t.direction, t.sentAt),
  ],
);

/** Inbound events that could not be matched to a person. */
export const identityExceptions = pgTable(
  "identity_exceptions",
  {
    id: pk(),
    organizationId: orgId(),
    channel: text("channel").notNull(),
    accountRef: text("account_ref").notNull(),
    sourceEventKey: text("source_event_key").notNull(),
    identityValue: text("identity_value"),
    reason: text("reason").notNull(),
    payload: jsonb("payload").$type<unknown>(),
    status: text("status").notNull().default("open"),
    resolvedPersonId: uuid("resolved_person_id"),
    resolvedAt: tstz("resolved_at"),
    createdAt: createdAt(),
  },
  (t) => [
    // The migration writes `ON DELETE SET NULL (resolved_person_id)`.
    foreignKey({ name: "identity_exceptions_resolved_person_fk", columns: [t.resolvedPersonId, t.organizationId], foreignColumns: [people.id, people.organizationId] }).onDelete("set null"),
    unique("identity_exceptions_event_uq").on(t.channel, t.accountRef, t.sourceEventKey),
    check("identity_exceptions_status_ck", sql`${t.status} in ('open', 'resolved', 'ignored')`),
    check("identity_exceptions_channel_ck", inList(t.channel, CHANNELS)),
    check(
      "identity_exceptions_keys_ck",
      sql`length(btrim(${t.accountRef})) > 0 and length(btrim(${t.sourceEventKey})) > 0 and length(btrim(${t.reason})) > 0`,
    ),
    // A resolved row keeps its status when its person is deleted: `resolved_person_id` goes null through the FK.
    check(
      "identity_exceptions_resolution_ck",
      sql`(${t.status} = 'open' and ${t.resolvedPersonId} is null and ${t.resolvedAt} is null)
        or (${t.status} = 'resolved' and ${t.resolvedAt} is not null)
        or (${t.status} = 'ignored' and ${t.resolvedPersonId} is null and ${t.resolvedAt} is not null)`,
    ),
    index("identity_exceptions_org_status_created_idx").on(t.organizationId, t.status, t.createdAt),
  ],
);

/**
 * CC recipients seen on inbound mail, per person. A hint for the human who
 * writes a reply: never enrolled, never emailed on their own.
 */
export const leadCcs = pgTable(
  "lead_ccs",
  {
    id: pk(),
    organizationId: orgId(),
    personId: uuid("person_id").notNull(),
    /** Lowercased, trimmed. */
    email: text("email").notNull(),
    firstSeenAt: tstz("first_seen_at").defaultNow().notNull(),
    lastSeenAt: tstz("last_seen_at").defaultNow().notNull(),
    /** Latest inbound message that carried this address. */
    sourceMessageId: uuid("source_message_id"),
  },
  (t) => [
    foreignKey({ columns: [t.personId, t.organizationId], foreignColumns: [people.id, people.organizationId] }).onDelete("cascade"),
    foreignKey({ columns: [t.sourceMessageId, t.organizationId], foreignColumns: [messages.id, messages.organizationId] }).onDelete("cascade"),
    uniqueIndex("lead_ccs_person_email_uq").on(t.personId, t.email),
    check("lead_ccs_email_ck", sql`${t.email} = lower(btrim(${t.email})) and position('@' in ${t.email}) > 1`),
    check("lead_ccs_seen_ck", sql`${t.lastSeenAt} >= ${t.firstSeenAt}`),
    index("lead_ccs_org_email_idx").on(t.organizationId, t.email),
    // The CASCADE from a deleted message.
    index("lead_ccs_source_message_idx").on(t.sourceMessageId).where(sql`${t.sourceMessageId} is not null`),
  ],
);

/** Append-only audit of what changed a record and who changed it. */
export const events = pgTable(
  "events",
  {
    id: pk(),
    organizationId: orgId(),
    personId: uuid("person_id").notNull(),
    recordId: uuid("record_id"),
    eventType: text("event_type").notNull(),
    actorType: text("actor_type").notNull(),
    /** The real user for human actions. */
    actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    actorRef: text("actor_ref"),
    fromData: jsonb("from_data").$type<unknown>(),
    toData: jsonb("to_data").$type<unknown>(),
    meta: jsonb("meta").$type<Record<string, unknown>>().default({}).notNull(),
    contextVersion: integer("context_version"),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({ columns: [t.personId, t.organizationId], foreignColumns: [people.id, people.organizationId] }).onDelete("restrict"),
    foreignKey({ columns: [t.recordId, t.organizationId], foreignColumns: [records.id, records.organizationId] }).onDelete("restrict"),
    check("events_actor_ck", sql`${t.actorType} in ('ai', 'human', 'system', 'integration')`),
    check("events_human_user_ck", sql`${t.actorType} <> 'human' or ${t.actorUserId} is not null`),
    check("events_type_ck", sql`length(btrim(${t.eventType})) > 0`),
    index("events_record_idx").on(t.recordId, t.createdAt),
    index("events_person_created_idx").on(t.personId, t.createdAt),
  ],
);

export const replyTypePicks = pgTable(
  "reply_type_picks",
  {
    id: pk(),
    organizationId: orgId(),
    recordId: uuid("record_id").notNull(),
    messageId: uuid("message_id").notNull(),
    /** The record's context_version when the work started. A mismatch at apply time makes this `stale`. */
    expectedContextVersion: integer("expected_context_version").notNull(),
    previousGroupKey: text("previous_group_key"),
    previousReplyTypeId: uuid("previous_reply_type_id"),
    proposedGroupKey: text("proposed_group_key"),
    proposedReplyTypeId: uuid("proposed_reply_type_id"),
    appliedGroupKey: text("applied_group_key"),
    appliedReplyTypeId: uuid("applied_reply_type_id"),
    confidence: numeric("confidence", { precision: 5, scale: 4 }),
    reasoning: text("reasoning"),
    status: text("status").notNull().default("proposed"),
    provider: text("provider"),
    model: text("model"),
    request: jsonb("request").$type<unknown>(),
    response: jsonb("response").$type<unknown>(),
    /** The type rules the pick was decided with. Null for a pick that names no type (a stale or failed one). */
    rules: jsonb("rules").$type<TypeRules>(),
    error: text("error"),
    acknowledgedAt: tstz("acknowledged_at"),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({ columns: [t.recordId, t.organizationId], foreignColumns: [records.id, records.organizationId] }).onDelete("restrict"),
    foreignKey({ columns: [t.messageId, t.organizationId], foreignColumns: [messages.id, messages.organizationId] }).onDelete("restrict"),
    unique("reply_type_picks_id_org_uq").on(t.id, t.organizationId),
    // The migration writes `ON DELETE SET NULL (<column>)` for these three; Drizzle cannot express the column list.
    foreignKey({ name: "reply_type_picks_previous_reply_type_fk", columns: [t.previousReplyTypeId, t.organizationId], foreignColumns: [replyTypes.id, replyTypes.organizationId] }).onDelete("set null"),
    foreignKey({ name: "reply_type_picks_proposed_reply_type_fk", columns: [t.proposedReplyTypeId, t.organizationId], foreignColumns: [replyTypes.id, replyTypes.organizationId] }).onDelete("set null"),
    foreignKey({ name: "reply_type_picks_applied_reply_type_fk", columns: [t.appliedReplyTypeId, t.organizationId], foreignColumns: [replyTypes.id, replyTypes.organizationId] }).onDelete("set null"),
    unique("reply_type_picks_message_version_uq").on(t.messageId, t.expectedContextVersion),
    check(
      "reply_type_picks_status_ck",
      inList(t.status, ["proposed", "auto_applied", "accepted", "rejected", "overridden", "stale", "failed"]),
    ),
    check("reply_type_picks_confidence_ck", sql`${t.status} = 'failed' or ${t.confidence} is not null`),
    check("reply_type_picks_confidence_range_ck", sql`${t.confidence} is null or ${t.confidence} between 0 and 1`),
    check("reply_type_picks_context_version_ck", sql`${t.expectedContextVersion} >= 0`),
    check("reply_type_picks_rules_ck", sql`${t.rules} is null or jsonb_typeof(${t.rules}) = 'object'`),
    check(
      "reply_type_picks_group_keys_ck",
      sql`(${t.previousGroupKey} is null or ${inList(t.previousGroupKey, REPLY_TYPE_GROUP_KEYS)})
        and (${t.proposedGroupKey} is null or ${inList(t.proposedGroupKey, REPLY_TYPE_GROUP_KEYS)})
        and (${t.appliedGroupKey} is null or ${inList(t.appliedGroupKey, REPLY_TYPE_GROUP_KEYS)})`,
    ),
    index("reply_type_picks_record_created_idx").on(t.recordId, t.createdAt),
  ],
);

/** AI body and human edit stay separate so we can tell what the person changed. */
export const drafts = pgTable(
  "drafts",
  {
    id: pk(),
    organizationId: orgId(),
    recordId: uuid("record_id").notNull(),
    conversationId: uuid("conversation_id").notNull(),
    replyForMessageId: uuid("reply_for_message_id"),
    expectedContextVersion: integer("expected_context_version").notNull(),
    revision: integer("revision").notNull().default(1),
    channel: text("channel").notNull(),
    subject: text("subject"),
    aiBodyText: text("ai_body_text"),
    aiBodyHtml: text("ai_body_html"),
    editedBodyText: text("edited_body_text"),
    editedBodyHtml: text("edited_body_html"),
    /** CC recipients the human chose for this reply (lowercased addresses from lead_ccs). Empty by default. */
    cc: text("cc").array().notNull().default(sql`'{}'::text[]`),
    status: text("status").$type<DraftStatus>().notNull().default("generating"),
    provider: text("provider"),
    model: text("model"),
    request: jsonb("request").$type<unknown>(),
    response: jsonb("response").$type<unknown>(),
    error: text("error"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({ columns: [t.recordId, t.organizationId], foreignColumns: [records.id, records.organizationId] }).onDelete("restrict"),
    foreignKey({ columns: [t.conversationId, t.organizationId], foreignColumns: [conversations.id, conversations.organizationId] }).onDelete("restrict"),
    // The migration writes `ON DELETE SET NULL (reply_for_message_id)`.
    foreignKey({ name: "drafts_reply_message_fk", columns: [t.replyForMessageId, t.organizationId], foreignColumns: [messages.id, messages.organizationId] }).onDelete("set null"),
    unique("drafts_id_org_uq").on(t.id, t.organizationId),
    check("drafts_context_version_ck", sql`${t.expectedContextVersion} >= 0`),
    check("drafts_status_ck", inList(t.status, DRAFT_STATUSES)),
    check("drafts_channel_ck", inList(t.channel, CHANNELS)),
    check("drafts_revision_ck", sql`${t.revision} >= 1`),
    check("drafts_cc_email_only_ck", sql`${t.channel} = 'email' or cardinality(${t.cc}) = 0`),
    check("drafts_subject_ck", sql`${t.channel} = 'email' or ${t.subject} is null`),
    index("drafts_record_status_idx").on(t.recordId, t.status),
    // The SET NULL from a deleted message and the RESTRICT check of a deleted conversation.
    index("drafts_reply_for_message_idx").on(t.replyForMessageId).where(sql`${t.replyForMessageId} is not null`),
    index("drafts_conversation_idx").on(t.conversationId),
    // One draft per conversation with a provider call in flight or unresolved.
    uniqueIndex("drafts_one_in_flight_uq").on(t.conversationId).where(inList(t.status, IN_FLIGHT_DRAFT_STATUSES)),
  ],
);

/** The exactly-once send ledger: one row per attempt, at most one terminal outcome per draft. */
export const sendAttempts = pgTable(
  "send_attempts",
  {
    id: pk(),
    organizationId: orgId(),
    draftId: uuid("draft_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull().unique(),
    status: text("status").$type<AttemptStatus>().notNull().default("prepared"),
    actorUserId: uuid("actor_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    requestId: text("request_id"),
    provider: text("provider"),
    accountRef: text("account_ref"),
    providerRequestId: text("provider_request_id"),
    providerMessageId: text("provider_message_id"),
    request: jsonb("request").$type<unknown>(),
    response: jsonb("response").$type<unknown>(),
    error: text("error"),
    reconciledAt: tstz("reconciled_at"),
    reconciliationNote: text("reconciliation_note"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({ columns: [t.draftId, t.organizationId], foreignColumns: [drafts.id, drafts.organizationId] }).onDelete("restrict"),
    check("send_attempts_status_ck", inList(t.status, ["prepared", "sending", "sent", "failed", "delivery_uncertain", "reconciled"])),
    check("send_attempts_reconciled_ck", sql`${t.status} <> 'reconciled' or ${t.reconciliationNote} is not null`),
    check(
      "send_attempts_refs_ck",
      sql`length(btrim(${t.idempotencyKey})) > 0
        and (${t.requestId} is null or length(btrim(${t.requestId})) > 0)
        and (${t.provider} is null or length(btrim(${t.provider})) > 0)
        and (${t.accountRef} is null or length(btrim(${t.accountRef})) > 0)`,
    ),
    uniqueIndex("send_attempts_one_terminal_uq")
      .on(t.draftId)
      .where(sql`${t.status} in ('sent', 'delivery_uncertain', 'reconciled')`),
    index("send_attempts_draft_created_idx").on(t.draftId, t.createdAt),
  ],
);

export const KNOWLEDGE_KINDS = ["company", "product", "pricing", "faq", "case_study", "objection", "scheduling", "custom"] as const;

export const knowledgeDocuments = pgTable(
  "knowledge_documents",
  {
    id: pk(),
    organizationId: orgId(),
    title: text("title").notNull(),
    kind: text("kind").notNull(),
    tags: text("tags").array().default(sql`'{}'::text[]`).notNull(),
    alwaysInclude: boolean("always_include").notNull().default(false),
    active: boolean("active").notNull().default(true),
    latestVersion: integer("latest_version").notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("knowledge_documents_id_org_uq").on(t.id, t.organizationId),
    check("knowledge_documents_kind_ck", inList(t.kind, KNOWLEDGE_KINDS)),
    check("knowledge_documents_version_ck", sql`${t.latestVersion} > 0`),
    index("knowledge_documents_org_active_idx").on(t.organizationId, t.active, t.kind),
  ],
);

export const knowledgeDocumentVersions = pgTable(
  "knowledge_document_versions",
  {
    id: pk(),
    organizationId: orgId(),
    documentId: uuid("document_id").notNull(),
    version: integer("version").notNull(),
    content: text("content").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({ columns: [t.documentId, t.organizationId], foreignColumns: [knowledgeDocuments.id, knowledgeDocuments.organizationId] }).onDelete("cascade"),
    unique("knowledge_versions_doc_version_uq").on(t.documentId, t.version),
    unique("knowledge_versions_id_org_uq").on(t.id, t.organizationId),
    check("knowledge_versions_ck", sql`${t.version} > 0 and length(btrim(${t.content})) > 0`),
  ],
);

/** Which knowledge version a draft cited. */
export const draftKnowledgeCitations = pgTable(
  "draft_knowledge_citations",
  {
    organizationId: orgId(),
    draftId: uuid("draft_id").notNull(),
    documentVersionId: uuid("document_version_id").notNull(),
    excerptHash: text("excerpt_hash").notNull(),
    excerpt: text("excerpt").notNull(),
    rank: numeric("rank").notNull().default("0"),
  },
  (t) => [
    primaryKey({ columns: [t.draftId, t.documentVersionId, t.excerptHash] }),
    foreignKey({ columns: [t.draftId, t.organizationId], foreignColumns: [drafts.id, drafts.organizationId] }).onDelete("cascade"),
    foreignKey({ columns: [t.documentVersionId, t.organizationId], foreignColumns: [knowledgeDocumentVersions.id, knowledgeDocumentVersions.organizationId] }).onDelete("restrict"),
    check("draft_citations_rank_ck", sql`${t.rank} >= 0`),
  ],
);

export const AI_JOB_KINDS = ["classification", "initial_draft"] as const;

/** Durable AI work queue. Workers claim with FOR UPDATE SKIP LOCKED and a lease. */
export const aiJobs = pgTable(
  "ai_jobs",
  {
    id: pk(),
    organizationId: orgId(),
    kind: text("kind").notNull(),
    status: text("status").$type<AiJobStatus>().notNull().default("queued"),
    /** message for classification, classification for initial_draft. Polymorphic by design, so no FK. */
    entityType: text("entity_type").notNull(),
    entityId: uuid("entity_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull().unique(),
    payload: jsonb("payload").$type<Record<string, unknown>>().default({}).notNull(),
    priority: integer("priority").notNull().default(0),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(3),
    runAfter: tstz("run_after").defaultNow().notNull(),
    lockedAt: tstz("locked_at"),
    lockedBy: text("locked_by"),
    startedAt: tstz("started_at"),
    completedAt: tstz("completed_at"),
    failedAt: tstz("failed_at"),
    lastError: text("last_error"),
    /** The token of the claim that holds the row, new on each claim. A settle that no longer holds it changes nothing. */
    claimToken: uuid("claim_token"),
    createdAt: createdAt(),
  },
  (t) => [
    unique("ai_jobs_entity_uq").on(t.kind, t.entityType, t.entityId),
    check("ai_jobs_kind_ck", inList(t.kind, AI_JOB_KINDS)),
    check("ai_jobs_status_ck", inList(t.status, AI_JOB_STATUSES)),
    check(
      "ai_jobs_kind_entity_ck",
      sql`(${t.kind} = 'classification' and ${t.entityType} = 'message') or (${t.kind} = 'initial_draft' and ${t.entityType} = 'classification')`,
    ),
    check(
      "ai_jobs_lock_ck",
      sql`(${t.status} = 'running') = (${t.lockedAt} is not null and ${t.lockedBy} is not null and ${t.startedAt} is not null)`,
    ),
    check("ai_jobs_attempts_ck", sql`${t.attempts} <= ${t.maxAttempts}`),
    check("ai_jobs_attempts_range_ck", sql`${t.attempts} >= 0 and ${t.maxAttempts} > 0`),
    check("ai_jobs_completion_ck", sql`${t.status} not in ('succeeded', 'skipped') or ${t.completedAt} is not null`),
    check("ai_jobs_failed_ck", sql`${t.status} <> 'failed' or (${t.failedAt} is not null and length(btrim(${t.lastError})) > 0)`),
    index("ai_jobs_claim_idx").on(t.status, t.runAfter, t.priority),
    index("ai_jobs_stale_lock_idx").on(t.status, t.lockedAt),
    // The failed-jobs list of the ops page (listFailed) filters one organization and orders by failed_at.
    index("ai_jobs_org_failed_idx").on(t.organizationId, t.failedAt).where(sql`${t.status} = 'failed'`),
  ],
);

export const notes = pgTable(
  "notes",
  {
    id: pk(),
    organizationId: orgId(),
    personId: uuid("person_id").notNull(),
    recordId: uuid("record_id"),
    title: text("title"),
    body: text("body").notNull(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({ columns: [t.personId, t.organizationId], foreignColumns: [people.id, people.organizationId] }).onDelete("cascade"),
    // The migration writes `ON DELETE SET NULL (record_id)`.
    foreignKey({ name: "notes_record_fk", columns: [t.recordId, t.organizationId], foreignColumns: [records.id, records.organizationId] }).onDelete("set null"),
    index("notes_person_idx").on(t.personId, t.createdAt),
  ],
);

export const tasks = pgTable(
  "tasks",
  {
    id: pk(),
    organizationId: orgId(),
    personId: uuid("person_id").notNull(),
    recordId: uuid("record_id"),
    name: text("name").notNull(),
    description: text("description"),
    isCompleted: boolean("is_completed").notNull().default(false),
    dueAt: tstz("due_at"),
    /** Who has to do it. Null: unassigned. */
    assignedTo: uuid("assigned_to").references(() => users.id, { onDelete: "set null" }),
    completedAt: tstz("completed_at"),
    completedBy: uuid("completed_by").references(() => users.id, { onDelete: "set null" }),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({ columns: [t.personId, t.organizationId], foreignColumns: [people.id, people.organizationId] }).onDelete("cascade"),
    // The migration writes `ON DELETE SET NULL (record_id)`.
    foreignKey({ name: "tasks_record_fk", columns: [t.recordId, t.organizationId], foreignColumns: [records.id, records.organizationId] }).onDelete("set null"),
    index("tasks_person_idx").on(t.personId, t.isCompleted),
    // Actions queue: open tasks by due date, overdue first.
    index("tasks_org_open_due_idx").on(t.organizationId, t.dueAt).where(sql`not ${t.isCompleted}`),
    index("tasks_assignee_open_idx").on(t.assignedTo, t.dueAt).where(sql`not ${t.isCompleted}`),
  ],
);
