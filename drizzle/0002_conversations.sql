CREATE TABLE "ai_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"run_after" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_at" timestamp with time zone,
	"locked_by" text,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"failed_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_jobs_idempotency_key_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "ai_jobs_entity_uq" UNIQUE("kind","entity_type","entity_id"),
	CONSTRAINT "ai_jobs_kind_ck" CHECK ("ai_jobs"."kind" in ('classification', 'initial_draft')),
	CONSTRAINT "ai_jobs_status_ck" CHECK ("ai_jobs"."status" in ('queued', 'running', 'succeeded', 'failed')),
	CONSTRAINT "ai_jobs_kind_entity_ck" CHECK (("ai_jobs"."kind" = 'classification' and "ai_jobs"."entity_type" = 'message') or ("ai_jobs"."kind" = 'initial_draft' and "ai_jobs"."entity_type" = 'classification')),
	CONSTRAINT "ai_jobs_lock_ck" CHECK (("ai_jobs"."status" = 'running') = ("ai_jobs"."locked_at" is not null and "ai_jobs"."locked_by" is not null and "ai_jobs"."started_at" is not null)),
	CONSTRAINT "ai_jobs_attempts_ck" CHECK ("ai_jobs"."attempts" <= "ai_jobs"."max_attempts"),
	CONSTRAINT "ai_jobs_failed_ck" CHECK ("ai_jobs"."status" <> 'failed' or ("ai_jobs"."failed_at" is not null and length(btrim("ai_jobs"."last_error")) > 0))
);
--> statement-breakpoint
CREATE TABLE "classifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"record_id" uuid NOT NULL,
	"message_id" uuid NOT NULL,
	"expected_context_version" integer NOT NULL,
	"previous_category_key" text,
	"previous_subcategory_id" uuid,
	"proposed_category_key" text,
	"proposed_subcategory_id" uuid,
	"applied_category_key" text,
	"applied_subcategory_id" uuid,
	"confidence" numeric(5, 4),
	"reasoning" text,
	"status" text DEFAULT 'proposed' NOT NULL,
	"provider" text,
	"model" text,
	"request" jsonb,
	"response" jsonb,
	"error" text,
	"acknowledged_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "classifications_id_org_uq" UNIQUE("id","organization_id"),
	CONSTRAINT "classifications_message_version_uq" UNIQUE("message_id","expected_context_version"),
	CONSTRAINT "classifications_status_ck" CHECK ("classifications"."status" in ('proposed', 'auto_applied', 'accepted', 'rejected', 'overridden', 'stale', 'failed')),
	CONSTRAINT "classifications_confidence_ck" CHECK ("classifications"."status" = 'failed' or "classifications"."confidence" is not null)
);
--> statement-breakpoint
CREATE TABLE "contact_policies" (
	"person_id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"do_not_contact" boolean DEFAULT false NOT NULL,
	"reason" text,
	"source" text,
	"set_at" timestamp with time zone,
	"cleared_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contact_policies_source_ck" CHECK ("contact_policies"."source" is null or "contact_policies"."source" in ('human', 'integration', 'inbound_request')),
	CONSTRAINT "contact_policies_state_ck" CHECK ((
        ("contact_policies"."do_not_contact" and "contact_policies"."source" is not null and "contact_policies"."set_at" is not null and "contact_policies"."cleared_at" is null)
        or (not "contact_policies"."do_not_contact" and "contact_policies"."source" is not null and "contact_policies"."set_at" is not null and "contact_policies"."cleared_at" is not null and "contact_policies"."cleared_at" >= "contact_policies"."set_at")
        or (not "contact_policies"."do_not_contact" and "contact_policies"."source" is null and "contact_policies"."set_at" is null and "contact_policies"."cleared_at" is null)
      ))
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"record_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"account_ref" text NOT NULL,
	"provider_thread_id" text,
	"provider_contact_id" text,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversations_id_org_uq" UNIQUE("id","organization_id"),
	CONSTRAINT "conversations_id_channel_account_uq" UNIQUE("id","channel","account_ref"),
	CONSTRAINT "conversations_channel_ck" CHECK ("conversations"."channel" in ('email', 'linkedin', 'whatsapp')),
	CONSTRAINT "conversations_status_ck" CHECK ("conversations"."status" in ('active', 'closed'))
);
--> statement-breakpoint
CREATE TABLE "draft_knowledge_citations" (
	"organization_id" uuid NOT NULL,
	"draft_id" uuid NOT NULL,
	"document_version_id" uuid NOT NULL,
	"excerpt_hash" text NOT NULL,
	"excerpt" text NOT NULL,
	"rank" numeric DEFAULT '0' NOT NULL,
	CONSTRAINT "draft_knowledge_citations_draft_id_document_version_id_excerpt_hash_pk" PRIMARY KEY("draft_id","document_version_id","excerpt_hash"),
	CONSTRAINT "draft_citations_rank_ck" CHECK ("draft_knowledge_citations"."rank" >= 0)
);
--> statement-breakpoint
CREATE TABLE "drafts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"record_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"reply_for_message_id" uuid,
	"expected_context_version" integer NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"channel" text NOT NULL,
	"subject" text,
	"ai_body_text" text,
	"ai_body_html" text,
	"edited_body_text" text,
	"edited_body_html" text,
	"status" text DEFAULT 'generating' NOT NULL,
	"provider" text,
	"model" text,
	"request" jsonb,
	"response" jsonb,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "drafts_id_org_uq" UNIQUE("id","organization_id"),
	CONSTRAINT "drafts_status_ck" CHECK ("drafts"."status" in ('generating', 'awaiting_review', 'sending', 'sent', 'discarded', 'stale', 'failed', 'delivery_uncertain')),
	CONSTRAINT "drafts_channel_ck" CHECK ("drafts"."channel" in ('email', 'linkedin', 'whatsapp')),
	CONSTRAINT "drafts_revision_ck" CHECK ("drafts"."revision" >= 1),
	CONSTRAINT "drafts_subject_ck" CHECK ("drafts"."channel" = 'email' or "drafts"."subject" is null)
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"record_id" uuid,
	"event_type" text NOT NULL,
	"actor_type" text NOT NULL,
	"actor_user_id" uuid,
	"actor_ref" text,
	"from_data" jsonb,
	"to_data" jsonb,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"context_version" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "events_actor_ck" CHECK ("events"."actor_type" in ('ai', 'human', 'system', 'integration')),
	CONSTRAINT "events_human_user_ck" CHECK ("events"."actor_type" <> 'human' or "events"."actor_user_id" is not null)
);
--> statement-breakpoint
CREATE TABLE "identity_exceptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"account_ref" text NOT NULL,
	"source_event_key" text NOT NULL,
	"identity_value" text,
	"reason" text NOT NULL,
	"payload" jsonb,
	"status" text DEFAULT 'open' NOT NULL,
	"resolved_person_id" uuid,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "identity_exceptions_event_uq" UNIQUE("channel","account_ref","source_event_key"),
	CONSTRAINT "identity_exceptions_status_ck" CHECK ("identity_exceptions"."status" in ('open', 'resolved', 'ignored')),
	CONSTRAINT "identity_exceptions_resolution_ck" CHECK (("identity_exceptions"."status" = 'open' and "identity_exceptions"."resolved_person_id" is null and "identity_exceptions"."resolved_at" is null)
        or ("identity_exceptions"."status" = 'resolved' and "identity_exceptions"."resolved_person_id" is not null and "identity_exceptions"."resolved_at" is not null)
        or ("identity_exceptions"."status" = 'ignored' and "identity_exceptions"."resolved_person_id" is null and "identity_exceptions"."resolved_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "knowledge_document_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"content" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "knowledge_versions_doc_version_uq" UNIQUE("document_id","version"),
	CONSTRAINT "knowledge_versions_id_org_uq" UNIQUE("id","organization_id"),
	CONSTRAINT "knowledge_versions_ck" CHECK ("knowledge_document_versions"."version" > 0 and length(btrim("knowledge_document_versions"."content")) > 0)
);
--> statement-breakpoint
CREATE TABLE "knowledge_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"title" text NOT NULL,
	"kind" text NOT NULL,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"always_include" boolean DEFAULT false NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"latest_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "knowledge_documents_id_org_uq" UNIQUE("id","organization_id"),
	CONSTRAINT "knowledge_documents_kind_ck" CHECK ("knowledge_documents"."kind" in ('company', 'product', 'pricing', 'faq', 'case_study', 'objection', 'scheduling', 'custom')),
	CONSTRAINT "knowledge_documents_version_ck" CHECK ("knowledge_documents"."latest_version" > 0)
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"account_ref" text NOT NULL,
	"direction" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"provider_message_id" text,
	"subject" text,
	"from_address" text,
	"to_address" text,
	"cc" text[],
	"body_text" text NOT NULL,
	"body_html" text,
	"important" boolean DEFAULT false NOT NULL,
	"opened_at" timestamp with time zone,
	"raw" jsonb,
	"sent_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "messages_id_org_uq" UNIQUE("id","organization_id"),
	CONSTRAINT "messages_idempotency_uq" UNIQUE("channel","account_ref","idempotency_key"),
	CONSTRAINT "messages_direction_ck" CHECK ("messages"."direction" in ('inbound', 'outbound')),
	CONSTRAINT "messages_body_ck" CHECK (length(btrim("messages"."body_text")) > 0)
);
--> statement-breakpoint
CREATE TABLE "notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"record_id" uuid,
	"title" text,
	"body" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pipeline_settings" (
	"pipeline_id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"auto_apply_confidence" numeric(4, 3) DEFAULT '0.850' NOT NULL,
	"review_other" boolean DEFAULT true NOT NULL,
	"customer_requires_review" boolean DEFAULT true NOT NULL,
	"draft_instructions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"classification_instructions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pipeline_settings_confidence_ck" CHECK ("pipeline_settings"."auto_apply_confidence" between 0 and 1)
);
--> statement-breakpoint
CREATE TABLE "pipelines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pipelines_org_name_uq" UNIQUE("organization_id","name"),
	CONSTRAINT "pipelines_id_org_uq" UNIQUE("id","organization_id"),
	CONSTRAINT "pipelines_name_ck" CHECK (length(btrim("pipelines"."name")) > 0)
);
--> statement-breakpoint
CREATE TABLE "records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"pipeline_id" uuid NOT NULL,
	"category_key" text,
	"subcategory_id" uuid,
	"workflow_state" text DEFAULT 'unclassified' NOT NULL,
	"category_source" text,
	"category_locked" boolean DEFAULT false NOT NULL,
	"active_channel" text,
	"latest_inbound_message_id" uuid,
	"context_version" integer DEFAULT 0 NOT NULL,
	"last_inbound_at" timestamp with time zone,
	"last_outbound_at" timestamp with time zone,
	"last_interaction_at" timestamp with time zone,
	"next_action_at" timestamp with time zone,
	"closed_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "records_person_pipeline_uq" UNIQUE("person_id","pipeline_id"),
	CONSTRAINT "records_id_org_uq" UNIQUE("id","organization_id"),
	CONSTRAINT "records_category_ck" CHECK ("records"."category_key" is null or "records"."category_key" in ('customer', 'interested', 'not_interested', 'other')),
	CONSTRAINT "records_workflow_ck" CHECK ("records"."workflow_state" in ('unclassified', 'classifying', 'action_required', 'waiting', 'idle', 'paused', 'closed', 'error')),
	CONSTRAINT "records_source_ck" CHECK ("records"."category_source" is null or "records"."category_source" in ('ai', 'human', 'integration')),
	CONSTRAINT "records_category_source_pair_ck" CHECK (("records"."category_key" is null) = ("records"."category_source" is null)),
	CONSTRAINT "records_locked_ck" CHECK (not "records"."category_locked" or "records"."category_key" = 'customer'),
	CONSTRAINT "records_subcategory_needs_category_ck" CHECK ("records"."subcategory_id" is null or "records"."category_key" is not null),
	CONSTRAINT "records_version_ck" CHECK ("records"."context_version" >= 0)
);
--> statement-breakpoint
CREATE TABLE "send_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"draft_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"status" text DEFAULT 'prepared' NOT NULL,
	"actor_user_id" uuid NOT NULL,
	"request_id" text,
	"provider" text,
	"account_ref" text,
	"provider_request_id" text,
	"provider_message_id" text,
	"request" jsonb,
	"response" jsonb,
	"error" text,
	"reconciled_at" timestamp with time zone,
	"reconciliation_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "send_attempts_idempotency_key_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "send_attempts_status_ck" CHECK ("send_attempts"."status" in ('prepared', 'sending', 'sent', 'failed', 'delivery_uncertain', 'reconciled')),
	CONSTRAINT "send_attempts_reconciled_ck" CHECK ("send_attempts"."status" <> 'reconciled' or "send_attempts"."reconciliation_note" is not null)
);
--> statement-breakpoint
CREATE TABLE "subcategories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"pipeline_id" uuid NOT NULL,
	"category_key" text NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"classification_guidance" text,
	"active" boolean DEFAULT true NOT NULL,
	"review_required" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"stage_rank" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subcategories_pipeline_key_uq" UNIQUE("pipeline_id","key"),
	CONSTRAINT "subcategories_id_pipeline_category_uq" UNIQUE("id","pipeline_id","category_key"),
	CONSTRAINT "subcategories_id_org_uq" UNIQUE("id","organization_id"),
	CONSTRAINT "subcategories_category_ck" CHECK ("subcategories"."category_key" in ('customer', 'interested', 'not_interested', 'other')),
	CONSTRAINT "subcategories_key_ck" CHECK ("subcategories"."key" ~ '^[a-z][a-z0-9_]*$'),
	CONSTRAINT "subcategories_sort_ck" CHECK ("subcategories"."sort_order" >= 0 and ("subcategories"."stage_rank" is null or "subcategories"."stage_rank" >= 1))
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"record_id" uuid,
	"name" text NOT NULL,
	"description" text,
	"is_completed" boolean DEFAULT false NOT NULL,
	"due_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai_jobs" ADD CONSTRAINT "ai_jobs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "classifications" ADD CONSTRAINT "classifications_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "classifications" ADD CONSTRAINT "classifications_record_id_organization_id_records_id_organization_id_fk" FOREIGN KEY ("record_id","organization_id") REFERENCES "public"."records"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "classifications" ADD CONSTRAINT "classifications_message_id_organization_id_messages_id_organization_id_fk" FOREIGN KEY ("message_id","organization_id") REFERENCES "public"."messages"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_policies" ADD CONSTRAINT "contact_policies_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_policies" ADD CONSTRAINT "contact_policies_person_id_organization_id_people_id_organization_id_fk" FOREIGN KEY ("person_id","organization_id") REFERENCES "public"."people"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_record_id_organization_id_records_id_organization_id_fk" FOREIGN KEY ("record_id","organization_id") REFERENCES "public"."records"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "draft_knowledge_citations" ADD CONSTRAINT "draft_knowledge_citations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "draft_knowledge_citations" ADD CONSTRAINT "draft_knowledge_citations_draft_id_organization_id_drafts_id_organization_id_fk" FOREIGN KEY ("draft_id","organization_id") REFERENCES "public"."drafts"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "draft_knowledge_citations" ADD CONSTRAINT "draft_knowledge_citations_document_version_id_organization_id_knowledge_document_versions_id_organization_id_fk" FOREIGN KEY ("document_version_id","organization_id") REFERENCES "public"."knowledge_document_versions"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drafts" ADD CONSTRAINT "drafts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drafts" ADD CONSTRAINT "drafts_record_id_organization_id_records_id_organization_id_fk" FOREIGN KEY ("record_id","organization_id") REFERENCES "public"."records"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drafts" ADD CONSTRAINT "drafts_conversation_id_organization_id_conversations_id_organization_id_fk" FOREIGN KEY ("conversation_id","organization_id") REFERENCES "public"."conversations"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_person_id_organization_id_people_id_organization_id_fk" FOREIGN KEY ("person_id","organization_id") REFERENCES "public"."people"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_record_id_organization_id_records_id_organization_id_fk" FOREIGN KEY ("record_id","organization_id") REFERENCES "public"."records"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity_exceptions" ADD CONSTRAINT "identity_exceptions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity_exceptions" ADD CONSTRAINT "identity_exceptions_resolved_person_id_people_id_fk" FOREIGN KEY ("resolved_person_id") REFERENCES "public"."people"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_document_versions" ADD CONSTRAINT "knowledge_document_versions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_document_versions" ADD CONSTRAINT "knowledge_document_versions_document_id_organization_id_knowledge_documents_id_organization_id_fk" FOREIGN KEY ("document_id","organization_id") REFERENCES "public"."knowledge_documents"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_documents" ADD CONSTRAINT "knowledge_documents_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_organization_id_conversations_id_organization_id_fk" FOREIGN KEY ("conversation_id","organization_id") REFERENCES "public"."conversations"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_channel_account_ref_conversations_id_channel_account_ref_fk" FOREIGN KEY ("conversation_id","channel","account_ref") REFERENCES "public"."conversations"("id","channel","account_ref") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notes" ADD CONSTRAINT "notes_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notes" ADD CONSTRAINT "notes_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notes" ADD CONSTRAINT "notes_person_id_organization_id_people_id_organization_id_fk" FOREIGN KEY ("person_id","organization_id") REFERENCES "public"."people"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_settings" ADD CONSTRAINT "pipeline_settings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_settings" ADD CONSTRAINT "pipeline_settings_pipeline_id_organization_id_pipelines_id_organization_id_fk" FOREIGN KEY ("pipeline_id","organization_id") REFERENCES "public"."pipelines"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipelines" ADD CONSTRAINT "pipelines_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "records" ADD CONSTRAINT "records_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "records" ADD CONSTRAINT "records_person_id_organization_id_people_id_organization_id_fk" FOREIGN KEY ("person_id","organization_id") REFERENCES "public"."people"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "records" ADD CONSTRAINT "records_pipeline_id_organization_id_pipelines_id_organization_id_fk" FOREIGN KEY ("pipeline_id","organization_id") REFERENCES "public"."pipelines"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "records" ADD CONSTRAINT "records_subcategory_id_pipeline_id_category_key_subcategories_id_pipeline_id_category_key_fk" FOREIGN KEY ("subcategory_id","pipeline_id","category_key") REFERENCES "public"."subcategories"("id","pipeline_id","category_key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "send_attempts" ADD CONSTRAINT "send_attempts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "send_attempts" ADD CONSTRAINT "send_attempts_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "send_attempts" ADD CONSTRAINT "send_attempts_draft_id_organization_id_drafts_id_organization_id_fk" FOREIGN KEY ("draft_id","organization_id") REFERENCES "public"."drafts"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subcategories" ADD CONSTRAINT "subcategories_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subcategories" ADD CONSTRAINT "subcategories_pipeline_id_organization_id_pipelines_id_organization_id_fk" FOREIGN KEY ("pipeline_id","organization_id") REFERENCES "public"."pipelines"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_person_id_organization_id_people_id_organization_id_fk" FOREIGN KEY ("person_id","organization_id") REFERENCES "public"."people"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_jobs_claim_idx" ON "ai_jobs" USING btree ("status","run_after","priority");--> statement-breakpoint
CREATE INDEX "ai_jobs_stale_lock_idx" ON "ai_jobs" USING btree ("status","locked_at");--> statement-breakpoint
CREATE UNIQUE INDEX "conversations_thread_uq" ON "conversations" USING btree ("channel","account_ref","provider_thread_id") WHERE "conversations"."provider_thread_id" is not null;--> statement-breakpoint
CREATE INDEX "conversations_record_idx" ON "conversations" USING btree ("record_id");--> statement-breakpoint
CREATE INDEX "drafts_record_status_idx" ON "drafts" USING btree ("record_id","status");--> statement-breakpoint
CREATE INDEX "events_record_idx" ON "events" USING btree ("record_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "messages_provider_id_uq" ON "messages" USING btree ("channel","account_ref","provider_message_id") WHERE "messages"."provider_message_id" is not null;--> statement-breakpoint
CREATE INDEX "messages_conversation_sent_idx" ON "messages" USING btree ("conversation_id","sent_at");--> statement-breakpoint
CREATE INDEX "notes_person_idx" ON "notes" USING btree ("person_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "pipelines_one_default_uq" ON "pipelines" USING btree ("organization_id") WHERE "pipelines"."is_default";--> statement-breakpoint
CREATE INDEX "records_org_state_idx" ON "records" USING btree ("organization_id","workflow_state","last_interaction_at");--> statement-breakpoint
CREATE UNIQUE INDEX "send_attempts_one_terminal_uq" ON "send_attempts" USING btree ("draft_id") WHERE "send_attempts"."status" in ('sent', 'delivery_uncertain', 'reconciled');--> statement-breakpoint
CREATE INDEX "tasks_person_idx" ON "tasks" USING btree ("person_id","is_completed");