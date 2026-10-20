import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { users } from "@/contexts/identity/infrastructure/schema";
import { people } from "@/contexts/leads/infrastructure/schema";
import { createdAt, orgId, pk, tstz, updatedAt } from "@/platform/db/columns";

/**
 * Outreach: email and LinkedIn share one campaign and enrollment model,
 * split by `channel`. Sends are rows in `sends`; limits are computed from
 * them, so there is no counter to read and write back.
 */

export interface WorkingHours {
  timeZone: string;
  /** Keyed 0 (Sunday) to 6; absent day = off. */
  days: Record<string, Array<{ start: string; end: string }>>;
}

export const mailboxes = pgTable(
  "mailboxes",
  {
    id: pk(),
    organizationId: orgId(),
    /** Globally unique: inbound Gmail pushes resolve the organization through it. */
    emailAddress: text("email_address").notNull().unique(),
    displayName: text("display_name"),
    status: text("status").notNull().default("connecting"),
    lastError: text("last_error"),
    lastTestedAt: tstz("last_tested_at"),
    /** When the status last left `connected`; null while connected. Drives follow-up takeover by another mailbox. */
    unavailableSince: tstz("unavailable_since"),
    /** Gmail History cursor. Never overwritten by a watch renewal. */
    gmailHistoryCursor: text("gmail_history_cursor"),
    gmailWatchExpiresAt: tstz("gmail_watch_expires_at"),
    lastSyncedAt: tstz("last_synced_at"),
    dailySendLimit: integer("daily_send_limit").notNull().default(30),
    signatureHtml: text("signature_html"),
    workingHours: jsonb("working_hours").$type<WorkingHours>(),
    /** Earliest time the next email may leave this mailbox (spacing between sends). */
    nextSendAt: tstz("next_send_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("mailboxes_id_org_uq").on(t.id, t.organizationId),
    check("mailboxes_status_ck", sql`${t.status} in ('connecting', 'connected', 'failed', 'disabled')`),
    check("mailboxes_limit_ck", sql`${t.dailySendLimit} between 1 and 200`),
    index("mailboxes_org_idx").on(t.organizationId),
  ],
);

export const suppressionList = pgTable(
  "suppression_list",
  {
    id: pk(),
    organizationId: orgId(),
    /** Stored lowercased. */
    email: text("email").notNull(),
    reason: text("reason").notNull(),
    note: text("note"),
    createdAt: createdAt(),
  },
  (t) => [
    unique("suppression_org_email_uq").on(t.organizationId, t.email),
    check("suppression_reason_ck", sql`${t.reason} in ('unsubscribed', 'bounced', 'manual', 'complaint')`),
  ],
);

export const linkedinAccounts = pgTable(
  "linkedin_accounts",
  {
    id: pk(),
    organizationId: orgId(),
    /** The Unipile account id used for API calls. */
    providerAccountId: text("provider_account_id").notNull().unique(),
    /** The LinkedIn member id. Globally unique: webhooks resolve the organization through it. */
    linkedinId: text("linkedin_id").notNull().unique(),
    username: text("username"),
    name: text("name"),
    headline: text("headline"),
    profileData: jsonb("profile_data").$type<Record<string, unknown>>(),
    status: text("status").notNull().default("connected"),
    isPremium: boolean("is_premium").notNull().default(false),
    dailyInviteLimit: integer("daily_invite_limit").notNull().default(20),
    /** Cap on LinkedIn messages (first messages and replies) per UTC day. Counted from `sends` and `send_attempts`. */
    dailyMessageLimit: integer("daily_message_limit").notNull().default(50),
    /** Set when LinkedIn refuses invitations; cleared by the daily rollover. */
    limitReachedUntil: tstz("limit_reached_until"),
    searchLeadsToday: integer("search_leads_today").notNull().default(0),
    /** UTC day (yyyy-mm-dd) that `search_leads_today` counts. A claim on a later day starts the count again. */
    searchDay: text("search_day"),
    /** Holds the account for one search page (in use) and then for the pacing gap. Expires on its own after a crash. */
    searchLeaseUntil: tstz("search_lease_until"),
    workingHours: jsonb("working_hours").$type<WorkingHours>(),
    nextAllowedRunAt: tstz("next_allowed_run_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("linkedin_accounts_id_org_uq").on(t.id, t.organizationId),
    check("linkedin_accounts_status_ck", sql`${t.status} in ('connected', 'disconnected')`),
    check("linkedin_accounts_invite_limit_ck", sql`${t.dailyInviteLimit} between 1 and 100`),
    check("linkedin_accounts_message_limit_ck", sql`${t.dailyMessageLimit} between 1 and 200`),
  ],
);

/**
 * A pending Unipile hosted-auth connection. The notify callback carries the
 * link id and a secret; only the SHA-256 of the secret is stored. The row
 * ties the callback to the organization that asked for it.
 */
export const linkedinConnectLinks = pgTable(
  "linkedin_connect_links",
  {
    id: pk(),
    organizationId: orgId(),
    /** Unipile `name` field sent with the link; echoed back in the callback to find this row. */
    providerName: text("provider_name").notNull().unique(),
    /** hex SHA-256 of the notify secret. */
    secretHash: text("secret_hash").notNull(),
    url: text("url"),
    status: text("status").notNull().default("pending"),
    expiresAt: tstz("expires_at").notNull(),
    /** Unipile account id reported by the callback or by a sync. */
    providerAccountId: text("provider_account_id"),
    linkedinAccountId: uuid("linkedin_account_id"),
    lastError: text("last_error"),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    completedAt: tstz("completed_at"),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({ columns: [t.linkedinAccountId, t.organizationId], foreignColumns: [linkedinAccounts.id, linkedinAccounts.organizationId] }),
    check("linkedin_connect_links_status_ck", sql`${t.status} in ('pending', 'completed', 'expired', 'failed')`),
    check("linkedin_connect_links_hash_ck", sql`${t.secretHash} ~ '^[0-9a-f]{64}$'`),
    check("linkedin_connect_links_done_ck", sql`(${t.status} = 'completed') = (${t.completedAt} is not null)`),
    index("linkedin_connect_links_org_idx").on(t.organizationId, t.status, t.createdAt),
  ],
);

export interface CampaignStep {
  /** 1-based, contiguous. */
  stepNumber: number;
  /** email: initial or follow-up. linkedin: invitation, message (sent after acceptance). */
  kind: "email" | "invitation" | "message";
  subject?: string;
  body: string;
  /** Days to wait after the previous step. */
  waitDays: number;
}

export const campaigns = pgTable(
  "campaigns",
  {
    id: pk(),
    organizationId: orgId(),
    channel: text("channel").notNull(),
    name: text("name").notNull(),
    /** `personal` is private outreach (LinkedIn only): replies stay out of the Inbox and the AI. Fixed once the first send exists. */
    type: text("type").notNull().default("regular"),
    status: text("status").notNull().default("draft"),
    steps: jsonb("steps").$type<CampaignStep[]>().default([]).notNull(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    /** Set when a completed campaign is archived. Null means visible in the default list. */
    archivedAt: tstz("archived_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("campaigns_id_org_uq").on(t.id, t.organizationId),
    check("campaigns_channel_ck", sql`${t.channel} in ('email', 'linkedin')`),
    check("campaigns_status_ck", sql`${t.status} in ('draft', 'active', 'paused', 'completed')`),
    check("campaigns_type_ck", sql`${t.type} in ('regular', 'personal')`),
    check("campaigns_personal_linkedin_ck", sql`${t.type} = 'regular' or ${t.channel} = 'linkedin'`),
    index("campaigns_org_status_idx").on(t.organizationId, t.status),
  ],
);

/** Optional sender pool for a campaign. Empty means every connected mailbox or LinkedIn account in the organization. */
export const campaignSenders = pgTable(
  "campaign_senders",
  {
    id: pk(),
    organizationId: orgId(),
    campaignId: uuid("campaign_id").notNull(),
    mailboxId: uuid("mailbox_id"),
    linkedinAccountId: uuid("linkedin_account_id"),
  },
  (t) => [
    foreignKey({ columns: [t.campaignId, t.organizationId], foreignColumns: [campaigns.id, campaigns.organizationId] }).onDelete("cascade"),
    foreignKey({ columns: [t.mailboxId, t.organizationId], foreignColumns: [mailboxes.id, mailboxes.organizationId] }).onDelete("cascade"),
    foreignKey({ columns: [t.linkedinAccountId, t.organizationId], foreignColumns: [linkedinAccounts.id, linkedinAccounts.organizationId] }).onDelete("cascade"),
    check("campaign_senders_one_ck", sql`(${t.mailboxId} is null) <> (${t.linkedinAccountId} is null)`),
    uniqueIndex("campaign_senders_mailbox_uq").on(t.campaignId, t.mailboxId).where(sql`${t.mailboxId} is not null`),
    uniqueIndex("campaign_senders_linkedin_uq").on(t.campaignId, t.linkedinAccountId).where(sql`${t.linkedinAccountId} is not null`),
  ],
);

/** A person in a campaign. */
export const campaignEnrollments = pgTable(
  "campaign_enrollments",
  {
    id: pk(),
    organizationId: orgId(),
    campaignId: uuid("campaign_id").notNull(),
    personId: uuid("person_id").notNull(),
    /** Copied from the campaign so channel-specific claims can use one index. */
    channel: text("channel").notNull(),
    status: text("status").notNull().default("pending"),
    /** Steps already completed; the next step to send is currentStep + 1. */
    currentStep: integer("current_step").notNull().default(0),
    mailboxId: uuid("mailbox_id"),
    linkedinAccountId: uuid("linkedin_account_id"),
    nextSendAt: tstz("next_send_at"),
    lastSentAt: tstz("last_sent_at"),
    /** Per-enrollment merge fields on top of the person's own data. */
    mergeFields: jsonb("merge_fields").$type<Record<string, string>>().default({}).notNull(),
    stopReason: text("stop_reason"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({ columns: [t.campaignId, t.organizationId], foreignColumns: [campaigns.id, campaigns.organizationId] }).onDelete("cascade"),
    foreignKey({ columns: [t.personId, t.organizationId], foreignColumns: [people.id, people.organizationId] }).onDelete("restrict"),
    foreignKey({ columns: [t.mailboxId, t.organizationId], foreignColumns: [mailboxes.id, mailboxes.organizationId] }),
    foreignKey({ columns: [t.linkedinAccountId, t.organizationId], foreignColumns: [linkedinAccounts.id, linkedinAccounts.organizationId] }),
    unique("enrollments_campaign_person_uq").on(t.campaignId, t.personId),
    unique("enrollments_id_org_uq").on(t.id, t.organizationId),
    check("enrollments_channel_ck", sql`${t.channel} in ('email', 'linkedin')`),
    check(
      "enrollments_status_ck",
      sql`${t.status} in ('pending', 'active', 'replied', 'completed', 'bounced', 'suppressed', 'failed', 'cancelled', 'removed')`,
    ),
    check("enrollments_step_ck", sql`${t.currentStep} >= 0`),
    // The claim query scans active enrollments that are due.
    index("enrollments_due_idx").on(t.channel, t.nextSendAt).where(sql`${t.status} = 'active'`),
    index("enrollments_person_idx").on(t.personId),
  ],
);

/** LinkedIn-only progress for an enrollment. */
export const linkedinEnrollmentDetails = pgTable(
  "linkedin_enrollment_details",
  {
    enrollmentId: uuid("enrollment_id").primaryKey(),
    organizationId: orgId(),
    /** Unipile provider id once the profile is resolved. */
    providerId: text("provider_id"),
    profileUrl: text("profile_url"),
    connectionState: text("connection_state").notNull().default("none"),
    requestSentAt: tstz("request_sent_at"),
    acceptedAt: tstz("accepted_at"),
    inviteRetryCount: integer("invite_retry_count").notNull().default(0),
    resolveRetryCount: integer("resolve_retry_count").notNull().default(0),
    resolveNextAttemptAt: tstz("resolve_next_attempt_at"),
    resolveLastError: text("resolve_last_error"),
  },
  (t) => [
    foreignKey({ columns: [t.enrollmentId, t.organizationId], foreignColumns: [campaignEnrollments.id, campaignEnrollments.organizationId] }).onDelete("cascade"),
    check("linkedin_details_state_ck", sql`${t.connectionState} in ('none', 'request_sent', 'connected')`),
    index("linkedin_details_resolve_idx").on(t.resolveNextAttemptAt),
  ],
);

/**
 * One row per step attempt. Inserting the row is the claim: the unique key
 * means a step is sent once even if two ticks race. A daily limit is the
 * count of today's rows for the sender.
 */
export const sends = pgTable(
  "sends",
  {
    id: pk(),
    organizationId: orgId(),
    /** campaign: a step of an enrollment. test: a mailbox test send, no enrollment. */
    kind: text("kind").notNull().default("campaign"),
    /** Null only for kind=test. */
    enrollmentId: uuid("enrollment_id"),
    /** Null only for kind=test. */
    stepNumber: integer("step_number"),
    channel: text("channel").notNull(),
    /** Recipient of a test send. Null for campaign sends (the person is on the enrollment). */
    toAddress: text("to_address"),
    /** Admin who triggered a test send. */
    requestedBy: uuid("requested_by").references(() => users.id, { onDelete: "set null" }),
    /** sending: claimed, provider call not confirmed. unknown: crashed or timed out mid-call, needs reconciliation. */
    status: text("status").notNull().default("sending"),
    mailboxId: uuid("mailbox_id"),
    /** Set when another mailbox took over this follow-up; the mailbox that sent the earlier steps. Null for ordinary sends. */
    takenOverFromMailboxId: uuid("taken_over_from_mailbox_id"),
    linkedinAccountId: uuid("linkedin_account_id"),
    subject: text("subject"),
    body: text("body"),
    /** Message-ID header we generate before sending, so an unknown send can be found in the mailbox. */
    rfcMessageId: text("rfc_message_id"),
    providerMessageId: text("provider_message_id"),
    threadId: text("thread_id"),
    inReplyTo: text("in_reply_to"),
    references: text("references").array(),
    attempt: integer("attempt").notNull().default(1),
    error: text("error"),
    claimedAt: tstz("claimed_at").defaultNow().notNull(),
    sentAt: tstz("sent_at"),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({ columns: [t.enrollmentId, t.organizationId], foreignColumns: [campaignEnrollments.id, campaignEnrollments.organizationId] }).onDelete("cascade"),
    // History blocks removal of its mailbox or account (no action). Migration 0012.
    foreignKey({ name: "sends_mailbox_fk", columns: [t.mailboxId, t.organizationId], foreignColumns: [mailboxes.id, mailboxes.organizationId] }),
    foreignKey({ name: "sends_taken_over_mailbox_fk", columns: [t.takenOverFromMailboxId, t.organizationId], foreignColumns: [mailboxes.id, mailboxes.organizationId] }),
    foreignKey({ name: "sends_linkedin_account_fk", columns: [t.linkedinAccountId, t.organizationId], foreignColumns: [linkedinAccounts.id, linkedinAccounts.organizationId] }),
    unique("sends_enrollment_step_uq").on(t.enrollmentId, t.stepNumber),
    check("sends_channel_ck", sql`${t.channel} in ('email', 'linkedin')`),
    check("sends_kind_ck", sql`${t.kind} in ('campaign', 'test')`),
    check(
      "sends_kind_shape_ck",
      sql`(${t.kind} = 'campaign' and ${t.enrollmentId} is not null and ${t.stepNumber} is not null)
        or (${t.kind} = 'test' and ${t.enrollmentId} is null and ${t.stepNumber} is null and ${t.channel} = 'email'
            and ${t.mailboxId} is not null and ${t.toAddress} is not null)`,
    ),
    // Test-send rate limit: count of a mailbox's recent test rows.
    index("sends_mailbox_test_idx").on(t.mailboxId, t.claimedAt).where(sql`${t.kind} = 'test'`),
    check("sends_status_ck", sql`${t.status} in ('sending', 'sent', 'failed', 'unknown')`),
    index("sends_mailbox_day_idx").on(t.mailboxId, t.claimedAt),
    index("sends_linkedin_day_idx").on(t.linkedinAccountId, t.claimedAt),
    // Organization-wide reads: the analytics read model, the unconfirmed sends count, the lead delete guard. Migration 0019.
    index("sends_org_status_idx").on(t.organizationId, t.status),
    uniqueIndex("sends_rfc_message_uq").on(t.rfcMessageId).where(sql`${t.rfcMessageId} is not null`),
    uniqueIndex("sends_provider_message_uq")
      .on(t.channel, t.providerMessageId)
      .where(sql`${t.providerMessageId} is not null`),
  ],
);

/** A LinkedIn first-degree connection with an account, and the chat used for messages. */
export const linkedinConnections = pgTable(
  "linkedin_connections",
  {
    id: pk(),
    organizationId: orgId(),
    linkedinAccountId: uuid("linkedin_account_id").notNull(),
    providerId: text("provider_id").notNull(),
    name: text("name"),
    headline: text("headline"),
    profileUrl: text("profile_url"),
    chatId: text("chat_id"),
    enrollmentId: uuid("enrollment_id").unique(),
    connectedAt: tstz("connected_at"),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({ columns: [t.linkedinAccountId, t.organizationId], foreignColumns: [linkedinAccounts.id, linkedinAccounts.organizationId] }).onDelete("cascade"),
    // Migration 0012 writes `ON DELETE SET NULL (enrollment_id)`.
    foreignKey({ name: "linkedin_connections_enrollment_fk", columns: [t.enrollmentId, t.organizationId], foreignColumns: [campaignEnrollments.id, campaignEnrollments.organizationId] }).onDelete("set null"),
    unique("linkedin_connections_provider_account_uq").on(t.providerId, t.linkedinAccountId),
  ],
);

/** Sales Navigator search: a batch holds queries, each yields results. */
export const linkedinSearchBatches = pgTable(
  "linkedin_search_batches",
  {
    id: pk(),
    organizationId: orgId(),
    name: text("name").notNull(),
    kind: text("kind").notNull().default("single"),
    accountIds: jsonb("account_ids").$type<string[]>().default([]).notNull(),
    /** Uploaded CSV name, for kind=upload. */
    sourceFilename: text("source_filename"),
    /** Rows in the upload, including rows rejected before a query was created. */
    rowsTotal: integer("rows_total"),
    rowsRejected: integer("rows_rejected"),
    /** Per-row rejection reasons for the upload report. */
    rejections: jsonb("rejections").$type<Array<{ row: number; reason: string }>>(),
    /** Result limit and target campaign the batch was created with. New searches added later take them, even when every earlier search was removed. */
    maxResults: integer("max_results"),
    targetCampaignId: uuid("target_campaign_id").references(() => campaigns.id, { onDelete: "set null" }),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  // listBatches() reads the organization's batches newest first.
  (t) => [index("linkedin_search_batches_org_created_idx").on(t.organizationId, t.createdAt)],
);

export const linkedinSearchQueries = pgTable(
  "linkedin_search_queries",
  {
    id: pk(),
    organizationId: orgId(),
    batchId: uuid("batch_id")
      .notNull()
      .references(() => linkedinSearchBatches.id, { onDelete: "cascade" }),
    url: text("url").notNull(),
    companyName: text("company_name"),
    /** 1-based CSV row the query came from. */
    sourceRow: integer("source_row"),
    /** Manual reruns of a failed query. */
    rerunCount: integer("rerun_count").notNull().default(0),
    status: text("status").notNull().default("queued"),
    cursor: text("cursor"),
    totalCount: integer("total_count"),
    leadsFetched: integer("leads_fetched").notNull().default(0),
    /** Stop after this many results. */
    maxResults: integer("max_results").notNull().default(100),
    /** Campaign that found people are enrolled into. Null: leads only. */
    targetCampaignId: uuid("target_campaign_id").references(() => campaigns.id, { onDelete: "set null" }),
    /** Results that became or matched a lead (the rest had no public profile slug). */
    importedCount: integer("imported_count").notNull().default(0),
    pagesFetched: integer("pages_fetched").notNull().default(0),
    /** Consecutive provider failures that left the outcome unknown. */
    failures: integer("failures").notNull().default(0),
    /** Earliest time of the next page: the pacing gap or a retry backoff. */
    nextPageAt: tstz("next_page_at"),
    lastError: text("last_error"),
    currentAccountId: uuid("current_account_id"),
    /** Lease, not a RUNNING flag: a crashed worker's claim expires on its own. */
    leaseUntil: tstz("lease_until"),
    startedAt: tstz("started_at"),
    completedAt: tstz("completed_at"),
    createdAt: createdAt(),
  },
  (t) => [
    // Migration 0012 writes `ON DELETE SET NULL (current_account_id)`.
    foreignKey({ name: "linkedin_search_queries_current_account_fk", columns: [t.currentAccountId, t.organizationId], foreignColumns: [linkedinAccounts.id, linkedinAccounts.organizationId] }).onDelete("set null"),
    check(
      "linkedin_search_queries_status_ck",
      sql`${t.status} in ('queued', 'running', 'paused', 'paused_limit', 'completed', 'failed', 'cancelled')`,
    ),
    index("linkedin_search_queries_claim_idx").on(t.status, t.leaseUntil),
    // Dedupe within a batch; the application normalizes the URL first.
    uniqueIndex("linkedin_search_queries_batch_url_uq").on(t.batchId, t.url),
    index("linkedin_search_queries_batch_idx").on(t.batchId, t.status),
    // list() reads the organization's single searches newest first.
    index("linkedin_search_queries_org_created_idx").on(t.organizationId, t.createdAt),
  ],
);

export const linkedinSearchResults = pgTable(
  "linkedin_search_results",
  {
    id: pk(),
    organizationId: orgId(),
    queryId: uuid("query_id")
      .notNull()
      .references(() => linkedinSearchQueries.id, { onDelete: "cascade" }),
    profileUrl: text("profile_url").notNull(),
    personId: uuid("person_id").references(() => people.id, { onDelete: "set null" }),
    name: text("name"),
    headline: text("headline"),
    location: text("location"),
    networkDistance: text("network_distance"),
    followersCount: integer("followers_count"),
    sharedConnectionsCount: integer("shared_connections_count"),
    raw: jsonb("raw").$type<unknown>(),
    createdAt: createdAt(),
  },
  (t) => [unique("linkedin_search_results_query_url_uq").on(t.queryId, t.profileUrl)],
);

/**
 * Provider deliveries (Gmail Pub/Sub, Unipile webhooks): written first, then
 * processed from the table, so a crash or provider outage loses nothing.
 * Doubles as the retry queue; workers claim rows with a lease.
 */
export const inboundEvents = pgTable(
  "inbound_events",
  {
    id: pk(),
    /** Resolved from the account or mailbox at ingest. Null until resolved. */
    organizationId: uuid("organization_id"),
    /** gmail | unipile */
    provider: text("provider").notNull(),
    /** Idempotency key from the provider. */
    providerEventKey: text("provider_event_key"),
    eventType: text("event_type").notNull(),
    /** Mailbox address or provider account id the event belongs to. */
    accountRef: text("account_ref"),
    payload: jsonb("payload").$type<unknown>().notNull(),
    status: text("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: tstz("next_attempt_at").defaultNow().notNull(),
    leaseUntil: tstz("lease_until"),
    log: jsonb("log").$type<Array<{ ts: string; level: string; message: string }>>().default([]).notNull(),
    processedAt: tstz("processed_at"),
    /** Admin replays of a failed delivery. The event key stays unique, so a replay re-queues this row and never adds one. */
    replayCount: integer("replay_count").notNull().default(0),
    lastReplayedAt: tstz("last_replayed_at"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("inbound_events_provider_key_uq")
      .on(t.provider, t.providerEventKey)
      .where(sql`${t.providerEventKey} is not null`),
    index("inbound_events_claim_idx").on(t.status, t.nextAttemptAt),
    index("inbound_events_org_status_idx").on(t.organizationId, t.provider, t.status, t.createdAt),
    check("inbound_events_replay_ck", sql`${t.replayCount} >= 0`),
    check("inbound_events_provider_ck", sql`${t.provider} in ('gmail', 'unipile')`),
    check("inbound_events_status_ck", sql`${t.status} in ('pending', 'processing', 'done', 'failed', 'skipped')`),
  ],
);
