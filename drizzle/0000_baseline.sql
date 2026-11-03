-- The MiaSDR schema, in one file. The tables, indexes and keys above the marker below come from
-- src/platform/db/schema.ts through drizzle-kit generate, with two kinds of edit Drizzle cannot express: a composite
-- foreign key that nulls one column (ON DELETE SET NULL (column)) and the deferred unique key on deal_stages.
-- docs/database.md describes the rules below the marker.
CREATE SEQUENCE "public"."grid_row_version_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE TABLE "accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" uuid NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jwks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"public_key" text NOT NULL,
	"private_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"alg" text,
	"crv" text
);
--> statement-breakpoint
CREATE TABLE "oauth_access_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token" text NOT NULL,
	"client_id" text NOT NULL,
	"session_id" uuid,
	"user_id" uuid,
	"reference_id" text,
	"authorization_code_id" text,
	"resources" text[],
	"requested_user_info_claims" text[],
	"refresh_id" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked" timestamp with time zone,
	"confirmation" jsonb,
	"scopes" text[] NOT NULL,
	CONSTRAINT "oauth_access_tokens_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "oauth_client_assertions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_client_resources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" text NOT NULL,
	"resource_id" text NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "oauth_clients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" text NOT NULL,
	"client_secret" text,
	"client_discovery_id" text,
	"disabled" boolean DEFAULT false,
	"skip_consent" boolean,
	"enable_end_session" boolean,
	"subject_type" text,
	"scopes" text[],
	"client_credentials_scopes" text[],
	"user_id" uuid,
	"created_at" timestamp with time zone,
	"updated_at" timestamp with time zone,
	"name" text,
	"uri" text,
	"icon" text,
	"contacts" text[],
	"tos" text,
	"policy" text,
	"software_id" text,
	"software_version" text,
	"software_statement" text,
	"redirect_uris" text[] NOT NULL,
	"post_logout_redirect_uris" text[],
	"backchannel_logout_uri" text,
	"backchannel_logout_session_required" boolean,
	"token_endpoint_auth_method" text,
	"application_type" text,
	"jwks" text,
	"jwks_uri" text,
	"grant_types" text[],
	"response_types" text[],
	"require_pkce" boolean,
	"dpop_bound_access_tokens" boolean,
	"reference_id" text,
	"metadata" jsonb,
	CONSTRAINT "oauth_clients_client_id_unique" UNIQUE("client_id")
);
--> statement-breakpoint
CREATE TABLE "oauth_consents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" text NOT NULL,
	"user_id" uuid,
	"reference_id" text,
	"resources" text[],
	"requested_user_info_claims" text[],
	"scopes" text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_refresh_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token" text NOT NULL,
	"client_id" text NOT NULL,
	"session_id" uuid,
	"user_id" uuid NOT NULL,
	"reference_id" text,
	"authorization_code_id" text,
	"resources" text[],
	"requested_user_info_claims" text[],
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked" timestamp with time zone,
	"rotated_at" timestamp with time zone,
	"rotation_replay_response" text,
	"rotation_replay_expires_at" timestamp with time zone,
	"auth_time" timestamp with time zone,
	"confirmation" jsonb,
	"scopes" text[] NOT NULL,
	CONSTRAINT "oauth_refresh_tokens_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "oauth_resources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"identifier" text NOT NULL,
	"name" text NOT NULL,
	"access_token_ttl" integer,
	"refresh_token_ttl" integer,
	"signing_algorithm" text,
	"signing_key_id" text,
	"allowed_scopes" text[],
	"custom_claims" jsonb,
	"dpop_bound_access_tokens_required" boolean,
	"disabled" boolean,
	"created_at" timestamp with time zone,
	"updated_at" timestamp with time zone,
	"policy_version" integer,
	"metadata" jsonb,
	CONSTRAINT "oauth_resources_identifier_unique" UNIQUE("identifier")
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" uuid NOT NULL,
	"active_organization_id" text,
	CONSTRAINT "sessions_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "verifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"actor_user_id" uuid,
	"action" text NOT NULL,
	"entity_type" text,
	"entity_id" text,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "audit_log_action_ck" CHECK (length(btrim("audit_log"."action")) > 0)
);
--> statement-breakpoint
CREATE TABLE "channel_settings" (
	"organization_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"values" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "channel_settings_organization_id_channel_pk" PRIMARY KEY("organization_id","channel")
);
--> statement-breakpoint
CREATE TABLE "invitations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"email" text NOT NULL,
	"role" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"inviter_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mcp_agent_usage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"day" date NOT NULL,
	"kind" text NOT NULL,
	"amount" integer NOT NULL,
	CONSTRAINT "mcp_agent_usage_org_day_kind_uq" UNIQUE("organization_id","day","kind"),
	CONSTRAINT "mcp_agent_usage_kind_ck" CHECK ("mcp_agent_usage"."kind" in ('spend_cents', 'search_leads', 'irreversible')),
	CONSTRAINT "mcp_agent_usage_amount_ck" CHECK ("mcp_agent_usage"."amount" >= 0)
);
--> statement-breakpoint
CREATE TABLE "mcp_rate_limits" (
	"organization_id" uuid NOT NULL,
	"token_id" uuid NOT NULL,
	"bucket" text NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"count" integer NOT NULL,
	CONSTRAINT "mcp_rate_limits_organization_id_token_id_bucket_pk" PRIMARY KEY("organization_id","token_id","bucket"),
	CONSTRAINT "mcp_rate_limits_count_ck" CHECK ("mcp_rate_limits"."count" >= 1)
);
--> statement-breakpoint
CREATE TABLE "mcp_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"token_hash" text,
	"token_hint" text,
	"oauth_grant_id" text,
	"scopes" text[] NOT NULL,
	"policy_epoch" integer DEFAULT 0 NOT NULL,
	"spend_epoch" integer DEFAULT 0 NOT NULL,
	"irreversible_epoch" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_tokens_token_hash_uq" UNIQUE("token_hash"),
	CONSTRAINT "mcp_tokens_oauth_grant_uq" UNIQUE("oauth_grant_id"),
	CONSTRAINT "mcp_tokens_id_org_uq" UNIQUE("id","organization_id"),
	CONSTRAINT "mcp_tokens_kind_ck" CHECK ("mcp_tokens"."kind" in ('pat', 'oauth')),
	CONSTRAINT "mcp_tokens_secret_ck" CHECK (("mcp_tokens"."kind" = 'pat' and "mcp_tokens"."token_hash" is not null and "mcp_tokens"."oauth_grant_id" is null) or ("mcp_tokens"."kind" = 'oauth' and "mcp_tokens"."oauth_grant_id" is not null and "mcp_tokens"."token_hash" is null and "mcp_tokens"."token_hint" is null)),
	CONSTRAINT "mcp_tokens_name_ck" CHECK (length(btrim("mcp_tokens"."name")) between 1 and 100),
	CONSTRAINT "mcp_tokens_policy_epoch_ck" CHECK ("mcp_tokens"."policy_epoch" >= 0),
	CONSTRAINT "mcp_tokens_spend_epoch_ck" CHECK ("mcp_tokens"."spend_epoch" >= 0),
	CONSTRAINT "mcp_tokens_irreversible_epoch_ck" CHECK ("mcp_tokens"."irreversible_epoch" >= 0)
);
--> statement-breakpoint
CREATE TABLE "mcp_tool_calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"token_id" uuid NOT NULL,
	"tool" text NOT NULL,
	"action" text,
	"kind" text NOT NULL,
	"target" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error_code" text,
	"client_name" text,
	"duration_ms" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_tool_calls_kind_ck" CHECK ("mcp_tool_calls"."kind" in ('read', 'write')),
	CONSTRAINT "mcp_tool_calls_duration_ck" CHECK ("mcp_tool_calls"."duration_ms" >= 0)
);
--> statement-breakpoint
CREATE TABLE "members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "members_organization_user_uq" UNIQUE("organization_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"logo" text,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"metadata" text,
	CONSTRAINT "organizations_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "companies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"domain" text NOT NULL,
	"name" text,
	"linkedin_url" text,
	"custom" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"raw" jsonb,
	"source" text,
	"crm_listed_at" timestamp with time zone,
	"version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "companies_org_domain_uq" UNIQUE("organization_id","domain"),
	CONSTRAINT "companies_id_org_uq" UNIQUE("id","organization_id"),
	CONSTRAINT "companies_raw_size_ck" CHECK ("companies"."raw" is null or octet_length("companies"."raw"::text) <= 262144),
	CONSTRAINT "companies_version_ck" CHECK ("companies"."version" >= 0)
);
--> statement-breakpoint
CREATE TABLE "company_domain_aliases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"domain" text NOT NULL,
	"merged_company_id" uuid,
	"merged_name" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "company_domain_aliases_org_domain_uq" UNIQUE("organization_id","domain"),
	CONSTRAINT "company_domain_aliases_domain_ck" CHECK ("company_domain_aliases"."domain" = lower(btrim("company_domain_aliases"."domain")) and length("company_domain_aliases"."domain") between 3 and 253)
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
	CONSTRAINT "contact_policies_source_ck" CHECK ("contact_policies"."source" is null or "contact_policies"."source" in ('human', 'integration')),
	CONSTRAINT "contact_policies_state_ck" CHECK ((
        ("contact_policies"."do_not_contact" and "contact_policies"."source" is not null and "contact_policies"."set_at" is not null and "contact_policies"."cleared_at" is null)
        or (not "contact_policies"."do_not_contact" and "contact_policies"."source" is not null and "contact_policies"."set_at" is not null and "contact_policies"."cleared_at" is not null and "contact_policies"."cleared_at" >= "contact_policies"."set_at")
        or (not "contact_policies"."do_not_contact" and "contact_policies"."source" is null and "contact_policies"."set_at" is null and "contact_policies"."cleared_at" is null)
      ))
);
--> statement-breakpoint
CREATE TABLE "entity_columns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"entity" text NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"is_core" boolean DEFAULT false NOT NULL,
	"position" double precision DEFAULT 0 NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "entity_columns_org_entity_key_uq" UNIQUE("organization_id","entity","key"),
	CONSTRAINT "entity_columns_entity_ck" CHECK ("entity_columns"."entity" in ('people', 'companies')),
	CONSTRAINT "entity_columns_key_ck" CHECK ("entity_columns"."key" ~ '^[a-z][a-z0-9_]*$')
);
--> statement-breakpoint
CREATE TABLE "import_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"filename" text,
	"mapping" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"stats" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "people" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"email" text,
	"linkedin_slug" text,
	"linkedin_url" text,
	"first_name" text,
	"last_name" text,
	"full_name" text,
	"title" text,
	"profile_picture_url" text,
	"phone" text,
	"company_id" uuid,
	"custom" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"raw" jsonb,
	"source" text,
	"lifecycle" text DEFAULT 'lead' NOT NULL,
	"converted_at" timestamp with time zone,
	"creation_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "people_id_org_uq" UNIQUE("id","organization_id"),
	CONSTRAINT "people_raw_size_ck" CHECK ("people"."raw" is null or octet_length("people"."raw"::text) <= 262144),
	CONSTRAINT "people_lifecycle_ck" CHECK ("people"."lifecycle" in ('lead', 'contact')),
	CONSTRAINT "people_converted_at_ck" CHECK (("people"."lifecycle" = 'contact') = ("people"."converted_at" is not null)),
	CONSTRAINT "people_creation_key_ck" CHECK ("people"."creation_key" is null or char_length("people"."creation_key") between 8 and 200)
);
--> statement-breakpoint
CREATE TABLE "suppression_list" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"email" text NOT NULL,
	"reason" text NOT NULL,
	"note" text,
	"added_in_settings" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "suppression_org_email_uq" UNIQUE("organization_id","email"),
	CONSTRAINT "suppression_reason_ck" CHECK ("suppression_list"."reason" in ('unsubscribed', 'bounced', 'manual', 'complaint'))
);
--> statement-breakpoint
CREATE TABLE "integration_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "integration_accounts_org_key_uq" UNIQUE("organization_id","key"),
	CONSTRAINT "integration_accounts_kind_ck" CHECK ("integration_accounts"."kind" in ('enrichment', 'platform', 'ai'))
);
--> statement-breakpoint
CREATE TABLE "integration_credentials" (
	"account_id" uuid PRIMARY KEY NOT NULL,
	"encrypted_payload" text NOT NULL,
	"encryption_version" text DEFAULT 'v1' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "campaign_enrollments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"campaign_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"current_step" integer DEFAULT 0 NOT NULL,
	"mailbox_id" uuid,
	"linkedin_account_id" uuid,
	"next_send_at" timestamp with time zone,
	"last_sent_at" timestamp with time zone,
	"merge_fields" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"stop_reason" text,
	"enrolled_via_token_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "enrollments_campaign_person_uq" UNIQUE("campaign_id","person_id"),
	CONSTRAINT "enrollments_id_org_uq" UNIQUE("id","organization_id"),
	CONSTRAINT "enrollments_channel_ck" CHECK ("campaign_enrollments"."channel" in ('email', 'linkedin')),
	CONSTRAINT "enrollments_status_ck" CHECK ("campaign_enrollments"."status" in ('pending', 'active', 'replied', 'completed', 'bounced', 'suppressed', 'failed', 'cancelled', 'removed')),
	CONSTRAINT "enrollments_step_ck" CHECK ("campaign_enrollments"."current_step" >= 0)
);
--> statement-breakpoint
CREATE TABLE "campaign_senders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"campaign_id" uuid NOT NULL,
	"mailbox_id" uuid,
	"linkedin_account_id" uuid,
	CONSTRAINT "campaign_senders_one_ck" CHECK (("campaign_senders"."mailbox_id" is null) <> ("campaign_senders"."linkedin_account_id" is null))
);
--> statement-breakpoint
CREATE TABLE "campaigns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"name" text NOT NULL,
	"type" text DEFAULT 'regular' NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"steps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_by" uuid,
	"archived_at" timestamp with time zone,
	"started_via_token_id" uuid,
	"person_paused" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "campaigns_id_org_uq" UNIQUE("id","organization_id"),
	CONSTRAINT "campaigns_channel_ck" CHECK ("campaigns"."channel" in ('email', 'linkedin')),
	CONSTRAINT "campaigns_status_ck" CHECK ("campaigns"."status" in ('draft', 'active', 'paused', 'completed')),
	CONSTRAINT "campaigns_type_ck" CHECK ("campaigns"."type" in ('regular', 'personal')),
	CONSTRAINT "campaigns_personal_linkedin_ck" CHECK ("campaigns"."type" = 'regular' or "campaigns"."channel" = 'linkedin')
);
--> statement-breakpoint
CREATE TABLE "inbound_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid,
	"provider" text NOT NULL,
	"provider_event_key" text,
	"event_type" text NOT NULL,
	"account_ref" text,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_until" timestamp with time zone,
	"log" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"processed_at" timestamp with time zone,
	"replay_count" integer DEFAULT 0 NOT NULL,
	"last_replayed_at" timestamp with time zone,
	"claim_token" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inbound_events_replay_ck" CHECK ("inbound_events"."replay_count" >= 0),
	CONSTRAINT "inbound_events_provider_ck" CHECK ("inbound_events"."provider" in ('gmail', 'unipile')),
	CONSTRAINT "inbound_events_status_ck" CHECK ("inbound_events"."status" in ('pending', 'processing', 'done', 'failed', 'skipped'))
);
--> statement-breakpoint
CREATE TABLE "linkedin_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider_account_id" text NOT NULL,
	"linkedin_id" text NOT NULL,
	"username" text,
	"name" text,
	"headline" text,
	"profile_data" jsonb,
	"status" text DEFAULT 'connected' NOT NULL,
	"is_premium" boolean DEFAULT false NOT NULL,
	"daily_invite_limit" integer DEFAULT 20 NOT NULL,
	"daily_message_limit" integer DEFAULT 50 NOT NULL,
	"limit_reached_until" timestamp with time zone,
	"search_leads_today" integer DEFAULT 0 NOT NULL,
	"search_day" text,
	"search_lease_until" timestamp with time zone,
	"working_hours" jsonb,
	"next_allowed_run_at" timestamp with time zone,
	"owner_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "linkedin_accounts_provider_account_id_unique" UNIQUE("provider_account_id"),
	CONSTRAINT "linkedin_accounts_linkedin_id_unique" UNIQUE("linkedin_id"),
	CONSTRAINT "linkedin_accounts_id_org_uq" UNIQUE("id","organization_id"),
	CONSTRAINT "linkedin_accounts_status_ck" CHECK ("linkedin_accounts"."status" in ('connected', 'disconnected')),
	CONSTRAINT "linkedin_accounts_invite_limit_ck" CHECK ("linkedin_accounts"."daily_invite_limit" between 1 and 100),
	CONSTRAINT "linkedin_accounts_message_limit_ck" CHECK ("linkedin_accounts"."daily_message_limit" between 1 and 200)
);
--> statement-breakpoint
CREATE TABLE "linkedin_connect_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider_name" text NOT NULL,
	"secret_hash" text NOT NULL,
	"url" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"provider_account_id" text,
	"linkedin_account_id" uuid,
	"last_error" text,
	"created_by" uuid,
	"owner_user_id" uuid,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "linkedin_connect_links_provider_name_unique" UNIQUE("provider_name"),
	CONSTRAINT "linkedin_connect_links_status_ck" CHECK ("linkedin_connect_links"."status" in ('pending', 'completed', 'expired', 'failed')),
	CONSTRAINT "linkedin_connect_links_hash_ck" CHECK ("linkedin_connect_links"."secret_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "linkedin_connect_links_done_ck" CHECK (("linkedin_connect_links"."status" = 'completed') = ("linkedin_connect_links"."completed_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "linkedin_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"linkedin_account_id" uuid NOT NULL,
	"provider_id" text NOT NULL,
	"name" text,
	"headline" text,
	"profile_url" text,
	"chat_id" text,
	"enrollment_id" uuid,
	"connected_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "linkedin_connections_enrollment_id_unique" UNIQUE("enrollment_id"),
	CONSTRAINT "linkedin_connections_provider_account_uq" UNIQUE("provider_id","linkedin_account_id")
);
--> statement-breakpoint
CREATE TABLE "linkedin_enrollment_details" (
	"enrollment_id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider_id" text,
	"profile_url" text,
	"connection_state" text DEFAULT 'none' NOT NULL,
	"request_sent_at" timestamp with time zone,
	"accepted_at" timestamp with time zone,
	"resolve_retry_count" integer DEFAULT 0 NOT NULL,
	"resolve_next_attempt_at" timestamp with time zone,
	"resolve_last_error" text,
	CONSTRAINT "linkedin_details_state_ck" CHECK ("linkedin_enrollment_details"."connection_state" in ('none', 'request_sent', 'connected'))
);
--> statement-breakpoint
CREATE TABLE "linkedin_search_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" text DEFAULT 'single' NOT NULL,
	"account_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"source_filename" text,
	"rows_total" integer,
	"rows_rejected" integer,
	"rejections" jsonb,
	"max_results" integer,
	"target_campaign_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "linkedin_search_batches_id_org_uq" UNIQUE("id","organization_id")
);
--> statement-breakpoint
CREATE TABLE "linkedin_search_queries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"batch_id" uuid NOT NULL,
	"url" text NOT NULL,
	"company_name" text,
	"source_row" integer,
	"rerun_count" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"cursor" text,
	"total_count" integer,
	"leads_fetched" integer DEFAULT 0 NOT NULL,
	"max_results" integer DEFAULT 100 NOT NULL,
	"target_campaign_id" uuid,
	"imported_count" integer DEFAULT 0 NOT NULL,
	"pages_fetched" integer DEFAULT 0 NOT NULL,
	"failures" integer DEFAULT 0 NOT NULL,
	"next_page_at" timestamp with time zone,
	"last_error" text,
	"current_account_id" uuid,
	"lease_until" timestamp with time zone,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_via_token_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "linkedin_search_queries_id_org_uq" UNIQUE("id","organization_id"),
	CONSTRAINT "linkedin_search_queries_status_ck" CHECK ("linkedin_search_queries"."status" in ('queued', 'running', 'paused', 'paused_limit', 'completed', 'failed', 'cancelled'))
);
--> statement-breakpoint
CREATE TABLE "linkedin_search_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"query_id" uuid NOT NULL,
	"profile_url" text NOT NULL,
	"person_id" uuid,
	"name" text,
	"headline" text,
	"location" text,
	"network_distance" text,
	"raw" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "linkedin_search_results_query_url_uq" UNIQUE("query_id","profile_url")
);
--> statement-breakpoint
CREATE TABLE "mailboxes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"email_address" text NOT NULL,
	"display_name" text,
	"status" text NOT NULL,
	"last_error" text,
	"last_tested_at" timestamp with time zone,
	"unavailable_since" timestamp with time zone,
	"gmail_history_cursor" text,
	"last_synced_at" timestamp with time zone,
	"daily_send_limit" integer DEFAULT 30 NOT NULL,
	"signature_html" text,
	"working_hours" jsonb,
	"next_send_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mailboxes_email_address_unique" UNIQUE("email_address"),
	CONSTRAINT "mailboxes_id_org_uq" UNIQUE("id","organization_id"),
	CONSTRAINT "mailboxes_status_ck" CHECK ("mailboxes"."status" in ('connected', 'failed', 'disabled')),
	CONSTRAINT "mailboxes_limit_ck" CHECK ("mailboxes"."daily_send_limit" between 1 and 200)
);
--> statement-breakpoint
CREATE TABLE "sends" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"kind" text DEFAULT 'campaign' NOT NULL,
	"enrollment_id" uuid,
	"step_number" integer,
	"channel" text NOT NULL,
	"to_address" text,
	"requested_by" uuid,
	"status" text DEFAULT 'sending' NOT NULL,
	"mailbox_id" uuid,
	"taken_over_from_mailbox_id" uuid,
	"linkedin_account_id" uuid,
	"subject" text,
	"body" text,
	"rfc_message_id" text,
	"provider_message_id" text,
	"thread_id" text,
	"in_reply_to" text,
	"references" text[],
	"attempt" integer DEFAULT 1 NOT NULL,
	"error" text,
	"claimed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	"next_check_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sends_enrollment_step_uq" UNIQUE("enrollment_id","step_number"),
	CONSTRAINT "sends_channel_ck" CHECK ("sends"."channel" in ('email', 'linkedin')),
	CONSTRAINT "sends_kind_ck" CHECK ("sends"."kind" in ('campaign', 'test')),
	CONSTRAINT "sends_kind_shape_ck" CHECK (("sends"."kind" = 'campaign' and "sends"."enrollment_id" is not null and "sends"."step_number" is not null)
        or ("sends"."kind" = 'test' and "sends"."enrollment_id" is null and "sends"."step_number" is null and "sends"."channel" = 'email'
            and "sends"."mailbox_id" is not null and "sends"."to_address" is not null)),
	CONSTRAINT "sends_status_ck" CHECK ("sends"."status" in ('sending', 'sent', 'failed', 'unknown'))
);
--> statement-breakpoint
CREATE TABLE "job_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid,
	"job" text NOT NULL,
	"slot" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"lease_until" timestamp with time zone,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "job_runs_job_slot_org_uq" UNIQUE NULLS NOT DISTINCT("job","slot","organization_id"),
	CONSTRAINT "job_runs_status_ck" CHECK ("job_runs"."status" in ('running', 'succeeded', 'failed'))
);
--> statement-breakpoint
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
	"claim_token" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_jobs_idempotency_key_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "ai_jobs_entity_uq" UNIQUE("kind","entity_type","entity_id"),
	CONSTRAINT "ai_jobs_kind_ck" CHECK ("ai_jobs"."kind" in ('classification', 'initial_draft')),
	CONSTRAINT "ai_jobs_status_ck" CHECK ("ai_jobs"."status" in ('queued', 'running', 'succeeded', 'failed', 'skipped')),
	CONSTRAINT "ai_jobs_kind_entity_ck" CHECK (("ai_jobs"."kind" = 'classification' and "ai_jobs"."entity_type" = 'message') or ("ai_jobs"."kind" = 'initial_draft' and "ai_jobs"."entity_type" = 'classification')),
	CONSTRAINT "ai_jobs_lock_ck" CHECK (("ai_jobs"."status" = 'running') = ("ai_jobs"."locked_at" is not null and "ai_jobs"."locked_by" is not null and "ai_jobs"."started_at" is not null)),
	CONSTRAINT "ai_jobs_attempts_ck" CHECK ("ai_jobs"."attempts" <= "ai_jobs"."max_attempts"),
	CONSTRAINT "ai_jobs_attempts_range_ck" CHECK ("ai_jobs"."attempts" >= 0 and "ai_jobs"."max_attempts" > 0),
	CONSTRAINT "ai_jobs_completion_ck" CHECK ("ai_jobs"."status" not in ('succeeded', 'skipped') or "ai_jobs"."completed_at" is not null),
	CONSTRAINT "ai_jobs_failed_ck" CHECK ("ai_jobs"."status" <> 'failed' or ("ai_jobs"."failed_at" is not null and length(btrim("ai_jobs"."last_error")) > 0))
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
	"private_campaign_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversations_id_org_uq" UNIQUE("id","organization_id"),
	CONSTRAINT "conversations_id_channel_account_uq" UNIQUE("id","channel","account_ref"),
	CONSTRAINT "conversations_channel_ck" CHECK ("conversations"."channel" in ('email', 'linkedin', 'whatsapp')),
	CONSTRAINT "conversations_status_ck" CHECK ("conversations"."status" in ('active', 'closed')),
	CONSTRAINT "conversations_account_ref_ck" CHECK (length(btrim("conversations"."account_ref")) > 0)
);
--> statement-breakpoint
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
	"edited_body_text" text,
	"cc" text[] DEFAULT '{}'::text[] NOT NULL,
	"status" text DEFAULT 'generating' NOT NULL,
	"provider" text,
	"model" text,
	"request" jsonb,
	"response" jsonb,
	"error" text,
	"written_via_token_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "drafts_id_org_uq" UNIQUE("id","organization_id"),
	CONSTRAINT "drafts_context_version_ck" CHECK ("drafts"."expected_context_version" >= 0),
	CONSTRAINT "drafts_status_ck" CHECK ("drafts"."status" in ('generating', 'awaiting_review', 'sending', 'sent', 'discarded', 'stale', 'failed', 'delivery_uncertain')),
	CONSTRAINT "drafts_channel_ck" CHECK ("drafts"."channel" in ('email', 'linkedin', 'whatsapp')),
	CONSTRAINT "drafts_revision_ck" CHECK ("drafts"."revision" >= 1),
	CONSTRAINT "drafts_cc_email_only_ck" CHECK ("drafts"."channel" = 'email' or cardinality("drafts"."cc") = 0),
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
	"from_data" jsonb,
	"to_data" jsonb,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"context_version" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "events_actor_ck" CHECK ("events"."actor_type" in ('ai', 'human', 'system', 'integration')),
	CONSTRAINT "events_human_user_ck" CHECK ("events"."actor_type" <> 'human' or "events"."actor_user_id" is not null),
	CONSTRAINT "events_type_ck" CHECK (length(btrim("events"."event_type")) > 0)
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
	CONSTRAINT "identity_exceptions_event_uq" UNIQUE("organization_id","channel","account_ref","source_event_key"),
	CONSTRAINT "identity_exceptions_status_ck" CHECK ("identity_exceptions"."status" in ('open', 'resolved', 'ignored')),
	CONSTRAINT "identity_exceptions_channel_ck" CHECK ("identity_exceptions"."channel" in ('email', 'linkedin', 'whatsapp')),
	CONSTRAINT "identity_exceptions_keys_ck" CHECK (length(btrim("identity_exceptions"."account_ref")) > 0 and length(btrim("identity_exceptions"."source_event_key")) > 0 and length(btrim("identity_exceptions"."reason")) > 0),
	CONSTRAINT "identity_exceptions_resolution_ck" CHECK (("identity_exceptions"."status" = 'open' and "identity_exceptions"."resolved_person_id" is null and "identity_exceptions"."resolved_at" is null)
        or ("identity_exceptions"."status" = 'resolved' and "identity_exceptions"."resolved_at" is not null)
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
CREATE TABLE "lead_ccs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"email" text NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source_message_id" uuid,
	CONSTRAINT "lead_ccs_email_ck" CHECK ("lead_ccs"."email" = lower(btrim("lead_ccs"."email")) and position('@' in "lead_ccs"."email") > 1),
	CONSTRAINT "lead_ccs_seen_ck" CHECK ("lead_ccs"."last_seen_at" >= "lead_ccs"."first_seen_at")
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
	"important" boolean DEFAULT false NOT NULL,
	"opened_at" timestamp with time zone,
	"raw" jsonb,
	"sent_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "messages_id_org_uq" UNIQUE("id","organization_id"),
	CONSTRAINT "messages_direction_ck" CHECK ("messages"."direction" in ('inbound', 'outbound')),
	CONSTRAINT "messages_body_ck" CHECK (length(btrim("messages"."body_text")) > 0),
	CONSTRAINT "messages_keys_ck" CHECK (length(btrim("messages"."idempotency_key")) > 0 and length(btrim("messages"."account_ref")) > 0)
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
CREATE TABLE "records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"reply_type_set_id" uuid NOT NULL,
	"group_key" text,
	"reply_type_id" uuid,
	"workflow_state" text DEFAULT 'unclassified' NOT NULL,
	"reply_type_source" text,
	"reply_type_locked" boolean DEFAULT false NOT NULL,
	"active_channel" text,
	"latest_inbound_message_id" uuid,
	"context_version" integer DEFAULT 0 NOT NULL,
	"last_inbound_at" timestamp with time zone,
	"last_outbound_at" timestamp with time zone,
	"last_interaction_at" timestamp with time zone,
	"next_action_at" timestamp with time zone,
	"closed_reason" text,
	"assigned_to" uuid,
	"assigned_source" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "records_person_reply_type_set_uq" UNIQUE("person_id","reply_type_set_id"),
	CONSTRAINT "records_id_org_uq" UNIQUE("id","organization_id"),
	CONSTRAINT "records_group_ck" CHECK ("records"."group_key" is null or "records"."group_key" in ('customer', 'interested', 'not_interested', 'other')),
	CONSTRAINT "records_workflow_ck" CHECK ("records"."workflow_state" in ('unclassified', 'classifying', 'action_required', 'waiting', 'idle', 'paused', 'closed', 'error')),
	CONSTRAINT "records_closed_reason_ck" CHECK ("records"."closed_reason" is null or "records"."workflow_state" = 'closed'),
	CONSTRAINT "records_source_ck" CHECK ("records"."reply_type_source" is null or "records"."reply_type_source" in ('ai', 'human', 'integration')),
	CONSTRAINT "records_reply_type_source_pair_ck" CHECK (("records"."group_key" is null) = ("records"."reply_type_source" is null)),
	CONSTRAINT "records_locked_ck" CHECK (not "records"."reply_type_locked" or "records"."group_key" = 'customer'),
	CONSTRAINT "records_reply_type_needs_group_ck" CHECK ("records"."reply_type_id" is null or "records"."group_key" is not null),
	CONSTRAINT "records_version_ck" CHECK ("records"."context_version" >= 0),
	CONSTRAINT "records_active_channel_ck" CHECK ("records"."active_channel" is null or "records"."active_channel" in ('email', 'linkedin', 'whatsapp')),
	CONSTRAINT "records_assigned_source_ck" CHECK (("records"."assigned_source" is null or "records"."assigned_source" in ('auto', 'human', 'cleared')) and ("records"."assigned_to" is null or "records"."assigned_source" is not null))
);
--> statement-breakpoint
CREATE TABLE "reply_handling_settings" (
	"reply_type_set_id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"auto_apply_confidence" numeric(4, 3) DEFAULT '0.850' NOT NULL,
	"draft_instructions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"classification_instructions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reply_handling_settings_confidence_ck" CHECK ("reply_handling_settings"."auto_apply_confidence" between 0 and 1),
	CONSTRAINT "reply_handling_settings_instructions_ck" CHECK (jsonb_typeof("reply_handling_settings"."draft_instructions") = 'array' and jsonb_typeof("reply_handling_settings"."classification_instructions") = 'array'
        and length("reply_handling_settings"."draft_instructions"::text) <= 100000 and length("reply_handling_settings"."classification_instructions"::text) <= 100000)
);
--> statement-breakpoint
CREATE TABLE "reply_type_picks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"record_id" uuid NOT NULL,
	"message_id" uuid NOT NULL,
	"expected_context_version" integer NOT NULL,
	"previous_group_key" text,
	"previous_reply_type_id" uuid,
	"proposed_group_key" text,
	"proposed_reply_type_id" uuid,
	"applied_group_key" text,
	"applied_reply_type_id" uuid,
	"confidence" numeric(5, 4),
	"reasoning" text,
	"status" text DEFAULT 'proposed' NOT NULL,
	"provider" text,
	"model" text,
	"request" jsonb,
	"response" jsonb,
	"rules" jsonb,
	"error" text,
	"acknowledged_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reply_type_picks_id_org_uq" UNIQUE("id","organization_id"),
	CONSTRAINT "reply_type_picks_message_version_uq" UNIQUE("message_id","expected_context_version"),
	CONSTRAINT "reply_type_picks_status_ck" CHECK ("reply_type_picks"."status" in ('proposed', 'auto_applied', 'accepted', 'rejected', 'overridden', 'stale', 'failed')),
	CONSTRAINT "reply_type_picks_confidence_ck" CHECK ("reply_type_picks"."status" = 'failed' or "reply_type_picks"."confidence" is not null),
	CONSTRAINT "reply_type_picks_confidence_range_ck" CHECK ("reply_type_picks"."confidence" is null or "reply_type_picks"."confidence" between 0 and 1),
	CONSTRAINT "reply_type_picks_context_version_ck" CHECK ("reply_type_picks"."expected_context_version" >= 0),
	CONSTRAINT "reply_type_picks_rules_ck" CHECK ("reply_type_picks"."rules" is null or jsonb_typeof("reply_type_picks"."rules") = 'object'),
	CONSTRAINT "reply_type_picks_group_keys_ck" CHECK (("reply_type_picks"."previous_group_key" is null or "reply_type_picks"."previous_group_key" in ('customer', 'interested', 'not_interested', 'other'))
        and ("reply_type_picks"."proposed_group_key" is null or "reply_type_picks"."proposed_group_key" in ('customer', 'interested', 'not_interested', 'other'))
        and ("reply_type_picks"."applied_group_key" is null or "reply_type_picks"."applied_group_key" in ('customer', 'interested', 'not_interested', 'other')))
);
--> statement-breakpoint
CREATE TABLE "reply_type_sets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reply_type_sets_org_name_uq" UNIQUE("organization_id","name"),
	CONSTRAINT "reply_type_sets_id_org_uq" UNIQUE("id","organization_id"),
	CONSTRAINT "reply_type_sets_name_ck" CHECK (length(btrim("reply_type_sets"."name")) > 0)
);
--> statement-breakpoint
CREATE TABLE "reply_types" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"reply_type_set_id" uuid NOT NULL,
	"group_key" text NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"classification_guidance" text,
	"active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"check_mode" text DEFAULT 'after' NOT NULL,
	"reply_draft" boolean DEFAULT true NOT NULL,
	"follow_ups" text DEFAULT 'continue' NOT NULL,
	"system_role" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reply_types_set_key_uq" UNIQUE("reply_type_set_id","key"),
	CONSTRAINT "reply_types_id_set_group_uq" UNIQUE("id","reply_type_set_id","group_key"),
	CONSTRAINT "reply_types_id_org_uq" UNIQUE("id","organization_id"),
	CONSTRAINT "reply_types_group_ck" CHECK ("reply_types"."group_key" in ('customer', 'interested', 'not_interested', 'other')),
	CONSTRAINT "reply_types_key_ck" CHECK ("reply_types"."key" ~ '^[a-z][a-z0-9_]*$'),
	CONSTRAINT "reply_types_sort_ck" CHECK ("reply_types"."sort_order" >= 0),
	CONSTRAINT "reply_types_rules_ck" CHECK ("reply_types"."check_mode" in ('before', 'after', 'skip') and "reply_types"."follow_ups" in ('continue', 'stop')),
	CONSTRAINT "reply_types_system_role_ck" CHECK ("reply_types"."system_role" is null or "reply_types"."system_role" in ('stop_request', 'customer')),
	CONSTRAINT "reply_types_stop_request_ck" CHECK ("reply_types"."system_role" is distinct from 'stop_request' or ("reply_types"."check_mode" = 'before' and not "reply_types"."reply_draft" and "reply_types"."follow_ups" = 'stop' and "reply_types"."active")),
	CONSTRAINT "reply_types_customer_ck" CHECK ("reply_types"."system_role" is distinct from 'customer' or "reply_types"."group_key" = 'customer')
);
--> statement-breakpoint
CREATE TABLE "send_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"draft_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"status" text DEFAULT 'prepared' NOT NULL,
	"actor_user_id" uuid NOT NULL,
	"provider" text,
	"account_ref" text,
	"provider_message_id" text,
	"request" jsonb,
	"response" jsonb,
	"error" text,
	"reconciled_at" timestamp with time zone,
	"reconciliation_note" text,
	"origin" text DEFAULT 'person' NOT NULL,
	"mcp_token_id" uuid,
	"client_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "send_attempts_org_idempotency_uq" UNIQUE("organization_id","idempotency_key"),
	CONSTRAINT "send_attempts_origin_ck" CHECK ("send_attempts"."origin" in ('person', 'agent') and ("send_attempts"."origin" = 'agent' or ("send_attempts"."mcp_token_id" is null and "send_attempts"."client_name" is null))),
	CONSTRAINT "send_attempts_status_ck" CHECK ("send_attempts"."status" in ('prepared', 'sending', 'sent', 'failed', 'delivery_uncertain', 'reconciled')),
	CONSTRAINT "send_attempts_reconciled_ck" CHECK ("send_attempts"."status" <> 'reconciled' or "send_attempts"."reconciliation_note" is not null),
	CONSTRAINT "send_attempts_refs_ck" CHECK (length(btrim("send_attempts"."idempotency_key")) > 0
        and ("send_attempts"."provider" is null or length(btrim("send_attempts"."provider")) > 0)
        and ("send_attempts"."account_ref" is null or length(btrim("send_attempts"."account_ref")) > 0))
);
--> statement-breakpoint
CREATE TABLE "stop_reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"message_id" uuid NOT NULL,
	"reviewed_by" uuid,
	"reviewed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "stop_reviews_message_uq" UNIQUE("message_id")
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
	"assigned_to" uuid,
	"completed_at" timestamp with time zone,
	"completed_by" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sequence_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"record_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"sequence_id" uuid NOT NULL,
	"sequence_version_id" uuid NOT NULL,
	"reply_type_id" uuid NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"current_step_position" integer DEFAULT 1 NOT NULL,
	"start_step_position" integer DEFAULT 1 NOT NULL,
	"started_by" text NOT NULL,
	"trigger_message_id" uuid NOT NULL,
	"last_inbound_at_start" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sequence_runs_id_org_uq" UNIQUE("id","organization_id"),
	CONSTRAINT "sequence_runs_status_ck" CHECK ("sequence_runs"."status" in ('active', 'interrupted', 'paused', 'completed', 'cancelled')),
	CONSTRAINT "sequence_runs_started_by_ck" CHECK ("sequence_runs"."started_by" in ('ai_assignment', 'human_override')),
	CONSTRAINT "sequence_runs_positions_ck" CHECK ("sequence_runs"."start_step_position" > 0 and "sequence_runs"."current_step_position" >= "sequence_runs"."start_step_position")
);
--> statement-breakpoint
CREATE TABLE "sequence_step_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"sequence_run_id" uuid NOT NULL,
	"sequence_step_id" uuid NOT NULL,
	"status" text DEFAULT 'scheduled' NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"draft_id" uuid,
	"sent_message_id" uuid,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"expected_context_version" integer NOT NULL,
	"claim_token" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sequence_step_runs_run_step_uq" UNIQUE("sequence_run_id","sequence_step_id"),
	CONSTRAINT "sequence_step_runs_status_ck" CHECK ("sequence_step_runs"."status" in ('scheduled', 'drafting', 'awaiting_review', 'sent', 'skipped', 'cancelled', 'failed')),
	CONSTRAINT "sequence_step_runs_attempts_ck" CHECK ("sequence_step_runs"."attempt_count" >= 0 and "sequence_step_runs"."expected_context_version" >= 0),
	CONSTRAINT "sequence_step_runs_sent_ck" CHECK ("sequence_step_runs"."status" <> 'sent' or "sequence_step_runs"."sent_message_id" is not null)
);
--> statement-breakpoint
CREATE TABLE "sequence_steps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"sequence_version_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"step_type" text NOT NULL,
	"name" text NOT NULL,
	"delay_minutes" integer NOT NULL,
	"subject_template" text,
	"body_template" text,
	"ai_instructions" text NOT NULL,
	"knowledge_tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sequence_steps_version_position_uq" UNIQUE("sequence_version_id","position"),
	CONSTRAINT "sequence_steps_id_org_uq" UNIQUE("id","organization_id"),
	CONSTRAINT "sequence_steps_name_ck" CHECK (length(btrim("sequence_steps"."name")) > 0 and length(btrim("sequence_steps"."ai_instructions")) > 0),
	CONSTRAINT "sequence_steps_delay_ck" CHECK ("sequence_steps"."delay_minutes" >= 0),
	CONSTRAINT "sequence_steps_semantics_ck" CHECK (("sequence_steps"."position" = 1 and "sequence_steps"."step_type" = 'reply' and "sequence_steps"."delay_minutes" = 0) or ("sequence_steps"."position" > 1 and "sequence_steps"."step_type" = 'follow_up'))
);
--> statement-breakpoint
CREATE TABLE "sequence_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"sequence_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sequence_versions_seq_version_uq" UNIQUE("sequence_id","version"),
	CONSTRAINT "sequence_versions_id_org_uq" UNIQUE("id","organization_id"),
	CONSTRAINT "sequence_versions_version_ck" CHECK ("sequence_versions"."version" > 0),
	CONSTRAINT "sequence_versions_status_ck" CHECK ("sequence_versions"."status" in ('draft', 'published')),
	CONSTRAINT "sequence_versions_published_ck" CHECK (("sequence_versions"."status" = 'draft') = ("sequence_versions"."published_at" is null))
);
--> statement-breakpoint
CREATE TABLE "sequences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"status" text DEFAULT 'active' NOT NULL,
	"campaign_id" uuid,
	"after_reply_enabled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sequences_id_org_uq" UNIQUE("id","organization_id"),
	CONSTRAINT "sequences_name_ck" CHECK (length(btrim("sequences"."name")) > 0),
	CONSTRAINT "sequences_status_ck" CHECK ("sequences"."status" in ('active', 'archived'))
);
--> statement-breakpoint
CREATE TABLE "grid_cell_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"table_id" uuid NOT NULL,
	"row_id" uuid NOT NULL,
	"column_key" text NOT NULL,
	"provider" text,
	"outcome" text NOT NULL,
	"cost_cents" numeric(12, 6) DEFAULT '0' NOT NULL,
	"credits" numeric(12, 4),
	"latency_ms" integer,
	"request" jsonb,
	"response" jsonb,
	"lookup_key" text,
	"answer" jsonb,
	"reused" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "grid_cell_runs_outcome_ck" CHECK ("grid_cell_runs"."outcome" in ('hit', 'miss', 'error', 'failed', 'skipped', 'cancelled')),
	CONSTRAINT "grid_cell_runs_cost_ck" CHECK ("grid_cell_runs"."cost_cents" >= 0 and ("grid_cell_runs"."latency_ms" is null or "grid_cell_runs"."latency_ms" >= 0)),
	CONSTRAINT "grid_cell_runs_credits_ck" CHECK ("grid_cell_runs"."credits" is null or "grid_cell_runs"."credits" >= 0)
);
--> statement-breakpoint
CREATE TABLE "grid_columns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"table_id" uuid NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"depends_on" text[] DEFAULT '{}'::text[] NOT NULL,
	"position" double precision NOT NULL,
	"auto_run" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "grid_columns_table_key_uq" UNIQUE("table_id","key"),
	CONSTRAINT "grid_columns_type_ck" CHECK ("grid_columns"."type" in ('text', 'number', 'currency', 'boolean', 'date', 'url', 'email', 'image', 'select', 'multiselect', 'json', 'enrichment', 'integration_output', 'ai_output', 'http', 'ai', 'functions', 'message', 'waterfall', 'formula', 'merge')),
	CONSTRAINT "grid_columns_key_ck" CHECK ("grid_columns"."key" <> '' and length(btrim("grid_columns"."name")) > 0)
);
--> statement-breakpoint
CREATE TABLE "grid_folders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"parent_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "grid_folders_id_org_uq" UNIQUE("id","organization_id"),
	CONSTRAINT "grid_folders_name_ck" CHECK (length(btrim("grid_folders"."name")) > 0),
	CONSTRAINT "grid_folders_parent_ck" CHECK ("grid_folders"."parent_id" is null or "grid_folders"."parent_id" <> "grid_folders"."id")
);
--> statement-breakpoint
CREATE TABLE "grid_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"table_id" uuid NOT NULL,
	"row_id" uuid NOT NULL,
	"column_key" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"run_after" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_at" timestamp with time zone,
	"error" text,
	"provider_state" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "grid_jobs_cell_uq" UNIQUE("row_id","column_key"),
	CONSTRAINT "grid_jobs_status_ck" CHECK ("grid_jobs"."status" in ('queued', 'running', 'waiting', 'succeeded', 'failed')),
	CONSTRAINT "grid_jobs_attempts_ck" CHECK ("grid_jobs"."attempts" >= 0 and "grid_jobs"."max_attempts" >= 1),
	CONSTRAINT "grid_jobs_lock_ck" CHECK ("grid_jobs"."status" <> 'running' or "grid_jobs"."locked_at" is not null)
);
--> statement-breakpoint
CREATE TABLE "grid_provider_credentials" (
	"provider_id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"encrypted_payload" text NOT NULL,
	"encryption_version" text DEFAULT 'v1' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "grid_provider_credentials_envelope_ck" CHECK ("grid_provider_credentials"."encrypted_payload" like "grid_provider_credentials"."encryption_version" || ':%')
);
--> statement-breakpoint
CREATE TABLE "grid_providers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"base_url" text,
	"default_cost_cents" numeric(12, 6) DEFAULT '0' NOT NULL,
	"rate_limit_per_min" integer,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "grid_providers_org_key_uq" UNIQUE("organization_id","key"),
	CONSTRAINT "grid_providers_id_org_uq" UNIQUE("id","organization_id"),
	CONSTRAINT "grid_providers_key_ck" CHECK ("grid_providers"."key" ~ '^[a-z][a-z0-9_-]*$' and length(btrim("grid_providers"."name")) > 0),
	CONSTRAINT "grid_providers_cost_ck" CHECK ("grid_providers"."default_cost_cents" >= 0 and ("grid_providers"."rate_limit_per_min" is null or "grid_providers"."rate_limit_per_min" > 0))
);
--> statement-breakpoint
CREATE TABLE "grid_rows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"table_id" uuid NOT NULL,
	"position" double precision NOT NULL,
	"cells" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"cell_meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"version" bigint DEFAULT nextval('grid_row_version_seq') NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "grid_rows_id_org_uq" UNIQUE("id","organization_id"),
	CONSTRAINT "grid_rows_cells_ck" CHECK (jsonb_typeof("grid_rows"."cells") = 'object' and jsonb_typeof("grid_rows"."cell_meta") = 'object')
);
--> statement-breakpoint
CREATE TABLE "grid_tables" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"workbook_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"auto_run" boolean DEFAULT true NOT NULL,
	"position" double precision NOT NULL,
	"view" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "grid_tables_id_org_uq" UNIQUE("id","organization_id"),
	CONSTRAINT "grid_tables_name_ck" CHECK (length(btrim("grid_tables"."name")) > 0)
);
--> statement-breakpoint
CREATE TABLE "grid_user_views" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"table_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"view" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "grid_user_views_table_user_uq" UNIQUE("table_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "grid_workbooks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"folder_id" uuid,
	"name" text NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "grid_workbooks_id_org_uq" UNIQUE("id","organization_id"),
	CONSTRAINT "grid_workbooks_name_ck" CHECK (length(btrim("grid_workbooks"."name")) > 0)
);
--> statement-breakpoint
CREATE TABLE "deal_stages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"position" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "deal_stages_id_org_uq" UNIQUE("id","organization_id"),
	CONSTRAINT "deal_stages_id_org_kind_uq" UNIQUE("id","organization_id","kind"),
	CONSTRAINT "deal_stages_org_position_uq" UNIQUE("organization_id","position") DEFERRABLE INITIALLY DEFERRED,
	CONSTRAINT "deal_stages_name_ck" CHECK (length(btrim("deal_stages"."name")) > 0 and length("deal_stages"."name") <= 60),
	CONSTRAINT "deal_stages_kind_ck" CHECK ("deal_stages"."kind" in ('open', 'won', 'lost'))
);
--> statement-breakpoint
CREATE TABLE "deals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"stage_id" uuid NOT NULL,
	"stage_kind" text NOT NULL,
	"title" text NOT NULL,
	"owner_user_id" uuid,
	"amount_minor" bigint,
	"currency" text,
	"expected_close_on" date,
	"closed_at" timestamp with time zone,
	"lost_reason" text,
	"stage_changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source_enrollment_id" uuid,
	"idempotency_key" text,
	"version" integer DEFAULT 0 NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "deals_id_org_uq" UNIQUE("id","organization_id"),
	CONSTRAINT "deals_title_ck" CHECK (length(btrim("deals"."title")) > 0 and length("deals"."title") <= 200),
	CONSTRAINT "deals_amount_ck" CHECK ("deals"."amount_minor" is null or ("deals"."amount_minor" >= 0 and "deals"."amount_minor" <= 9007199254740991)),
	CONSTRAINT "deals_currency_pair_ck" CHECK (("deals"."amount_minor" is null) = ("deals"."currency" is null)),
	CONSTRAINT "deals_closed_at_ck" CHECK (("deals"."stage_kind" <> 'open') = ("deals"."closed_at" is not null)),
	CONSTRAINT "deals_lost_reason_ck" CHECK (("deals"."stage_kind" = 'lost') = ("deals"."lost_reason" is not null)),
	CONSTRAINT "deals_lost_reason_len_ck" CHECK ("deals"."lost_reason" is null or length("deals"."lost_reason") <= 500),
	CONSTRAINT "deals_version_ck" CHECK ("deals"."version" >= 0)
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_access_tokens" ADD CONSTRAINT "oauth_access_tokens_client_id_oauth_clients_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_clients"("client_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_access_tokens" ADD CONSTRAINT "oauth_access_tokens_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_access_tokens" ADD CONSTRAINT "oauth_access_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_access_tokens" ADD CONSTRAINT "oauth_access_tokens_refresh_id_oauth_refresh_tokens_id_fk" FOREIGN KEY ("refresh_id") REFERENCES "public"."oauth_refresh_tokens"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_client_resources" ADD CONSTRAINT "oauth_client_resources_client_id_oauth_clients_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_clients"("client_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_client_resources" ADD CONSTRAINT "oauth_client_resources_resource_id_oauth_resources_identifier_fk" FOREIGN KEY ("resource_id") REFERENCES "public"."oauth_resources"("identifier") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_clients" ADD CONSTRAINT "oauth_clients_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_consents" ADD CONSTRAINT "oauth_consents_client_id_oauth_clients_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_clients"("client_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_consents" ADD CONSTRAINT "oauth_consents_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_refresh_tokens" ADD CONSTRAINT "oauth_refresh_tokens_client_id_oauth_clients_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_clients"("client_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_refresh_tokens" ADD CONSTRAINT "oauth_refresh_tokens_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_refresh_tokens" ADD CONSTRAINT "oauth_refresh_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_settings" ADD CONSTRAINT "channel_settings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_settings" ADD CONSTRAINT "channel_settings_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_inviter_id_users_id_fk" FOREIGN KEY ("inviter_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_agent_usage" ADD CONSTRAINT "mcp_agent_usage_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_rate_limits" ADD CONSTRAINT "mcp_rate_limits_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_rate_limits" ADD CONSTRAINT "mcp_rate_limits_token_fk" FOREIGN KEY ("token_id","organization_id") REFERENCES "public"."mcp_tokens"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_tokens" ADD CONSTRAINT "mcp_tokens_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_tokens" ADD CONSTRAINT "mcp_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_tool_calls" ADD CONSTRAINT "mcp_tool_calls_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_tool_calls" ADD CONSTRAINT "mcp_tool_calls_token_fk" FOREIGN KEY ("token_id","organization_id") REFERENCES "public"."mcp_tokens"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "members" ADD CONSTRAINT "members_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "members" ADD CONSTRAINT "members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "companies" ADD CONSTRAINT "companies_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_domain_aliases" ADD CONSTRAINT "company_domain_aliases_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_domain_aliases" ADD CONSTRAINT "company_domain_aliases_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_domain_aliases" ADD CONSTRAINT "company_domain_aliases_company_fk" FOREIGN KEY ("company_id","organization_id") REFERENCES "public"."companies"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_policies" ADD CONSTRAINT "contact_policies_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_policies" ADD CONSTRAINT "contact_policies_person_id_organization_id_people_id_organization_id_fk" FOREIGN KEY ("person_id","organization_id") REFERENCES "public"."people"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_columns" ADD CONSTRAINT "entity_columns_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_runs" ADD CONSTRAINT "import_runs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_runs" ADD CONSTRAINT "import_runs_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "people" ADD CONSTRAINT "people_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "people" ADD CONSTRAINT "people_company_fk" FOREIGN KEY ("company_id","organization_id") REFERENCES "public"."companies"("id","organization_id") ON DELETE SET NULL ("company_id") ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suppression_list" ADD CONSTRAINT "suppression_list_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_accounts" ADD CONSTRAINT "integration_accounts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_credentials" ADD CONSTRAINT "integration_credentials_account_id_integration_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."integration_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_enrollments" ADD CONSTRAINT "campaign_enrollments_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_enrollments" ADD CONSTRAINT "campaign_enrollments_campaign_id_organization_id_campaigns_id_organization_id_fk" FOREIGN KEY ("campaign_id","organization_id") REFERENCES "public"."campaigns"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_enrollments" ADD CONSTRAINT "campaign_enrollments_enrolled_via_token_fk" FOREIGN KEY ("enrolled_via_token_id","organization_id") REFERENCES "public"."mcp_tokens"("id","organization_id") ON DELETE SET NULL ("enrolled_via_token_id") ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_enrollments" ADD CONSTRAINT "campaign_enrollments_person_id_organization_id_people_id_organization_id_fk" FOREIGN KEY ("person_id","organization_id") REFERENCES "public"."people"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_enrollments" ADD CONSTRAINT "campaign_enrollments_mailbox_id_organization_id_mailboxes_id_organization_id_fk" FOREIGN KEY ("mailbox_id","organization_id") REFERENCES "public"."mailboxes"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_enrollments" ADD CONSTRAINT "campaign_enrollments_linkedin_account_id_organization_id_linkedin_accounts_id_organization_id_fk" FOREIGN KEY ("linkedin_account_id","organization_id") REFERENCES "public"."linkedin_accounts"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_senders" ADD CONSTRAINT "campaign_senders_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_senders" ADD CONSTRAINT "campaign_senders_campaign_id_organization_id_campaigns_id_organization_id_fk" FOREIGN KEY ("campaign_id","organization_id") REFERENCES "public"."campaigns"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_senders" ADD CONSTRAINT "campaign_senders_mailbox_id_organization_id_mailboxes_id_organization_id_fk" FOREIGN KEY ("mailbox_id","organization_id") REFERENCES "public"."mailboxes"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_senders" ADD CONSTRAINT "campaign_senders_linkedin_account_id_organization_id_linkedin_accounts_id_organization_id_fk" FOREIGN KEY ("linkedin_account_id","organization_id") REFERENCES "public"."linkedin_accounts"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_started_via_token_fk" FOREIGN KEY ("started_via_token_id","organization_id") REFERENCES "public"."mcp_tokens"("id","organization_id") ON DELETE SET NULL ("started_via_token_id") ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "linkedin_accounts" ADD CONSTRAINT "linkedin_accounts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "linkedin_accounts" ADD CONSTRAINT "linkedin_accounts_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "linkedin_connect_links" ADD CONSTRAINT "linkedin_connect_links_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "linkedin_connect_links" ADD CONSTRAINT "linkedin_connect_links_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "linkedin_connect_links" ADD CONSTRAINT "linkedin_connect_links_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "linkedin_connect_links" ADD CONSTRAINT "linkedin_connect_links_linkedin_account_id_organization_id_linkedin_accounts_id_organization_id_fk" FOREIGN KEY ("linkedin_account_id","organization_id") REFERENCES "public"."linkedin_accounts"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "linkedin_connections" ADD CONSTRAINT "linkedin_connections_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "linkedin_connections" ADD CONSTRAINT "linkedin_connections_linkedin_account_id_organization_id_linkedin_accounts_id_organization_id_fk" FOREIGN KEY ("linkedin_account_id","organization_id") REFERENCES "public"."linkedin_accounts"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "linkedin_connections" ADD CONSTRAINT "linkedin_connections_enrollment_fk" FOREIGN KEY ("enrollment_id","organization_id") REFERENCES "public"."campaign_enrollments"("id","organization_id") ON DELETE SET NULL ("enrollment_id") ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "linkedin_enrollment_details" ADD CONSTRAINT "linkedin_enrollment_details_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "linkedin_enrollment_details" ADD CONSTRAINT "linkedin_enrollment_details_enrollment_id_organization_id_campaign_enrollments_id_organization_id_fk" FOREIGN KEY ("enrollment_id","organization_id") REFERENCES "public"."campaign_enrollments"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "linkedin_search_batches" ADD CONSTRAINT "linkedin_search_batches_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "linkedin_search_batches" ADD CONSTRAINT "linkedin_search_batches_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "linkedin_search_batches" ADD CONSTRAINT "linkedin_search_batches_target_campaign_fk" FOREIGN KEY ("target_campaign_id","organization_id") REFERENCES "public"."campaigns"("id","organization_id") ON DELETE SET NULL ("target_campaign_id") ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "linkedin_search_queries" ADD CONSTRAINT "linkedin_search_queries_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "linkedin_search_queries" ADD CONSTRAINT "linkedin_search_queries_current_account_fk" FOREIGN KEY ("current_account_id","organization_id") REFERENCES "public"."linkedin_accounts"("id","organization_id") ON DELETE SET NULL ("current_account_id") ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "linkedin_search_queries" ADD CONSTRAINT "linkedin_search_queries_batch_fk" FOREIGN KEY ("batch_id","organization_id") REFERENCES "public"."linkedin_search_batches"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "linkedin_search_queries" ADD CONSTRAINT "linkedin_search_queries_target_campaign_fk" FOREIGN KEY ("target_campaign_id","organization_id") REFERENCES "public"."campaigns"("id","organization_id") ON DELETE SET NULL ("target_campaign_id") ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "linkedin_search_queries" ADD CONSTRAINT "linkedin_search_queries_created_via_token_fk" FOREIGN KEY ("created_via_token_id","organization_id") REFERENCES "public"."mcp_tokens"("id","organization_id") ON DELETE SET NULL ("created_via_token_id") ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "linkedin_search_results" ADD CONSTRAINT "linkedin_search_results_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "linkedin_search_results" ADD CONSTRAINT "linkedin_search_results_query_fk" FOREIGN KEY ("query_id","organization_id") REFERENCES "public"."linkedin_search_queries"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "linkedin_search_results" ADD CONSTRAINT "linkedin_search_results_person_fk" FOREIGN KEY ("person_id","organization_id") REFERENCES "public"."people"("id","organization_id") ON DELETE SET NULL ("person_id") ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mailboxes" ADD CONSTRAINT "mailboxes_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sends" ADD CONSTRAINT "sends_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sends" ADD CONSTRAINT "sends_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sends" ADD CONSTRAINT "sends_enrollment_id_organization_id_campaign_enrollments_id_organization_id_fk" FOREIGN KEY ("enrollment_id","organization_id") REFERENCES "public"."campaign_enrollments"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sends" ADD CONSTRAINT "sends_mailbox_fk" FOREIGN KEY ("mailbox_id","organization_id") REFERENCES "public"."mailboxes"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sends" ADD CONSTRAINT "sends_taken_over_mailbox_fk" FOREIGN KEY ("taken_over_from_mailbox_id","organization_id") REFERENCES "public"."mailboxes"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sends" ADD CONSTRAINT "sends_linkedin_account_fk" FOREIGN KEY ("linkedin_account_id","organization_id") REFERENCES "public"."linkedin_accounts"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_jobs" ADD CONSTRAINT "ai_jobs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_record_id_organization_id_records_id_organization_id_fk" FOREIGN KEY ("record_id","organization_id") REFERENCES "public"."records"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_private_campaign_fk" FOREIGN KEY ("private_campaign_id","organization_id") REFERENCES "public"."campaigns"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drafts" ADD CONSTRAINT "drafts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drafts" ADD CONSTRAINT "drafts_record_id_organization_id_records_id_organization_id_fk" FOREIGN KEY ("record_id","organization_id") REFERENCES "public"."records"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drafts" ADD CONSTRAINT "drafts_conversation_id_organization_id_conversations_id_organization_id_fk" FOREIGN KEY ("conversation_id","organization_id") REFERENCES "public"."conversations"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drafts" ADD CONSTRAINT "drafts_written_via_token_fk" FOREIGN KEY ("written_via_token_id","organization_id") REFERENCES "public"."mcp_tokens"("id","organization_id") ON DELETE SET NULL ("written_via_token_id") ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drafts" ADD CONSTRAINT "drafts_reply_message_fk" FOREIGN KEY ("reply_for_message_id","organization_id") REFERENCES "public"."messages"("id","organization_id") ON DELETE SET NULL ("reply_for_message_id") ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_person_id_organization_id_people_id_organization_id_fk" FOREIGN KEY ("person_id","organization_id") REFERENCES "public"."people"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_record_id_organization_id_records_id_organization_id_fk" FOREIGN KEY ("record_id","organization_id") REFERENCES "public"."records"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity_exceptions" ADD CONSTRAINT "identity_exceptions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity_exceptions" ADD CONSTRAINT "identity_exceptions_resolved_person_fk" FOREIGN KEY ("resolved_person_id","organization_id") REFERENCES "public"."people"("id","organization_id") ON DELETE SET NULL ("resolved_person_id") ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_document_versions" ADD CONSTRAINT "knowledge_document_versions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_document_versions" ADD CONSTRAINT "knowledge_document_versions_document_id_organization_id_knowledge_documents_id_organization_id_fk" FOREIGN KEY ("document_id","organization_id") REFERENCES "public"."knowledge_documents"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_documents" ADD CONSTRAINT "knowledge_documents_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_ccs" ADD CONSTRAINT "lead_ccs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_ccs" ADD CONSTRAINT "lead_ccs_person_id_organization_id_people_id_organization_id_fk" FOREIGN KEY ("person_id","organization_id") REFERENCES "public"."people"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_ccs" ADD CONSTRAINT "lead_ccs_source_message_id_organization_id_messages_id_organization_id_fk" FOREIGN KEY ("source_message_id","organization_id") REFERENCES "public"."messages"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_organization_id_conversations_id_organization_id_fk" FOREIGN KEY ("conversation_id","organization_id") REFERENCES "public"."conversations"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_channel_account_ref_conversations_id_channel_account_ref_fk" FOREIGN KEY ("conversation_id","channel","account_ref") REFERENCES "public"."conversations"("id","channel","account_ref") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notes" ADD CONSTRAINT "notes_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notes" ADD CONSTRAINT "notes_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notes" ADD CONSTRAINT "notes_person_id_organization_id_people_id_organization_id_fk" FOREIGN KEY ("person_id","organization_id") REFERENCES "public"."people"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notes" ADD CONSTRAINT "notes_record_fk" FOREIGN KEY ("record_id","organization_id") REFERENCES "public"."records"("id","organization_id") ON DELETE SET NULL ("record_id") ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "records" ADD CONSTRAINT "records_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "records" ADD CONSTRAINT "records_person_id_organization_id_people_id_organization_id_fk" FOREIGN KEY ("person_id","organization_id") REFERENCES "public"."people"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "records" ADD CONSTRAINT "records_reply_type_set_id_organization_id_reply_type_sets_id_organization_id_fk" FOREIGN KEY ("reply_type_set_id","organization_id") REFERENCES "public"."reply_type_sets"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "records" ADD CONSTRAINT "records_assigned_to_fk" FOREIGN KEY ("organization_id","assigned_to") REFERENCES "public"."members"("organization_id","user_id") ON DELETE SET NULL ("assigned_to") ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "records" ADD CONSTRAINT "records_reply_type_id_reply_type_set_id_group_key_reply_types_id_reply_type_set_id_group_key_fk" FOREIGN KEY ("reply_type_id","reply_type_set_id","group_key") REFERENCES "public"."reply_types"("id","reply_type_set_id","group_key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reply_handling_settings" ADD CONSTRAINT "reply_handling_settings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reply_handling_settings" ADD CONSTRAINT "reply_handling_settings_reply_type_set_id_organization_id_reply_type_sets_id_organization_id_fk" FOREIGN KEY ("reply_type_set_id","organization_id") REFERENCES "public"."reply_type_sets"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reply_type_picks" ADD CONSTRAINT "reply_type_picks_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reply_type_picks" ADD CONSTRAINT "reply_type_picks_record_id_organization_id_records_id_organization_id_fk" FOREIGN KEY ("record_id","organization_id") REFERENCES "public"."records"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reply_type_picks" ADD CONSTRAINT "reply_type_picks_message_id_organization_id_messages_id_organization_id_fk" FOREIGN KEY ("message_id","organization_id") REFERENCES "public"."messages"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reply_type_picks" ADD CONSTRAINT "reply_type_picks_previous_reply_type_fk" FOREIGN KEY ("previous_reply_type_id","organization_id") REFERENCES "public"."reply_types"("id","organization_id") ON DELETE SET NULL ("previous_reply_type_id") ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reply_type_picks" ADD CONSTRAINT "reply_type_picks_proposed_reply_type_fk" FOREIGN KEY ("proposed_reply_type_id","organization_id") REFERENCES "public"."reply_types"("id","organization_id") ON DELETE SET NULL ("proposed_reply_type_id") ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reply_type_picks" ADD CONSTRAINT "reply_type_picks_applied_reply_type_fk" FOREIGN KEY ("applied_reply_type_id","organization_id") REFERENCES "public"."reply_types"("id","organization_id") ON DELETE SET NULL ("applied_reply_type_id") ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reply_type_sets" ADD CONSTRAINT "reply_type_sets_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reply_types" ADD CONSTRAINT "reply_types_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reply_types" ADD CONSTRAINT "reply_types_reply_type_set_id_organization_id_reply_type_sets_id_organization_id_fk" FOREIGN KEY ("reply_type_set_id","organization_id") REFERENCES "public"."reply_type_sets"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "send_attempts" ADD CONSTRAINT "send_attempts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "send_attempts" ADD CONSTRAINT "send_attempts_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "send_attempts" ADD CONSTRAINT "send_attempts_draft_id_organization_id_drafts_id_organization_id_fk" FOREIGN KEY ("draft_id","organization_id") REFERENCES "public"."drafts"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "send_attempts" ADD CONSTRAINT "send_attempts_mcp_token_fk" FOREIGN KEY ("mcp_token_id","organization_id") REFERENCES "public"."mcp_tokens"("id","organization_id") ON DELETE SET NULL ("mcp_token_id") ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stop_reviews" ADD CONSTRAINT "stop_reviews_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stop_reviews" ADD CONSTRAINT "stop_reviews_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stop_reviews" ADD CONSTRAINT "stop_reviews_message_fk" FOREIGN KEY ("message_id","organization_id") REFERENCES "public"."messages"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_assigned_to_users_id_fk" FOREIGN KEY ("assigned_to") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_completed_by_users_id_fk" FOREIGN KEY ("completed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_person_id_organization_id_people_id_organization_id_fk" FOREIGN KEY ("person_id","organization_id") REFERENCES "public"."people"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_record_fk" FOREIGN KEY ("record_id","organization_id") REFERENCES "public"."records"("id","organization_id") ON DELETE SET NULL ("record_id") ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sequence_runs" ADD CONSTRAINT "sequence_runs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sequence_runs" ADD CONSTRAINT "sequence_runs_record_id_organization_id_records_id_organization_id_fk" FOREIGN KEY ("record_id","organization_id") REFERENCES "public"."records"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sequence_runs" ADD CONSTRAINT "sequence_runs_conversation_id_organization_id_conversations_id_organization_id_fk" FOREIGN KEY ("conversation_id","organization_id") REFERENCES "public"."conversations"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sequence_runs" ADD CONSTRAINT "sequence_runs_sequence_id_organization_id_sequences_id_organization_id_fk" FOREIGN KEY ("sequence_id","organization_id") REFERENCES "public"."sequences"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sequence_runs" ADD CONSTRAINT "sequence_runs_sequence_version_id_organization_id_sequence_versions_id_organization_id_fk" FOREIGN KEY ("sequence_version_id","organization_id") REFERENCES "public"."sequence_versions"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sequence_runs" ADD CONSTRAINT "sequence_runs_reply_type_id_organization_id_reply_types_id_organization_id_fk" FOREIGN KEY ("reply_type_id","organization_id") REFERENCES "public"."reply_types"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sequence_runs" ADD CONSTRAINT "sequence_runs_trigger_message_id_organization_id_messages_id_organization_id_fk" FOREIGN KEY ("trigger_message_id","organization_id") REFERENCES "public"."messages"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sequence_step_runs" ADD CONSTRAINT "sequence_step_runs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sequence_step_runs" ADD CONSTRAINT "sequence_step_runs_sequence_run_id_organization_id_sequence_runs_id_organization_id_fk" FOREIGN KEY ("sequence_run_id","organization_id") REFERENCES "public"."sequence_runs"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sequence_step_runs" ADD CONSTRAINT "sequence_step_runs_sequence_step_id_organization_id_sequence_steps_id_organization_id_fk" FOREIGN KEY ("sequence_step_id","organization_id") REFERENCES "public"."sequence_steps"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sequence_step_runs" ADD CONSTRAINT "sequence_step_runs_draft_id_organization_id_drafts_id_organization_id_fk" FOREIGN KEY ("draft_id","organization_id") REFERENCES "public"."drafts"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sequence_step_runs" ADD CONSTRAINT "sequence_step_runs_sent_message_id_organization_id_messages_id_organization_id_fk" FOREIGN KEY ("sent_message_id","organization_id") REFERENCES "public"."messages"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sequence_steps" ADD CONSTRAINT "sequence_steps_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sequence_steps" ADD CONSTRAINT "sequence_steps_sequence_version_id_organization_id_sequence_versions_id_organization_id_fk" FOREIGN KEY ("sequence_version_id","organization_id") REFERENCES "public"."sequence_versions"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sequence_versions" ADD CONSTRAINT "sequence_versions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sequence_versions" ADD CONSTRAINT "sequence_versions_sequence_id_organization_id_sequences_id_organization_id_fk" FOREIGN KEY ("sequence_id","organization_id") REFERENCES "public"."sequences"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sequences" ADD CONSTRAINT "sequences_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sequences" ADD CONSTRAINT "sequences_campaign_id_organization_id_campaigns_id_organization_id_fk" FOREIGN KEY ("campaign_id","organization_id") REFERENCES "public"."campaigns"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grid_cell_runs" ADD CONSTRAINT "grid_cell_runs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grid_cell_runs" ADD CONSTRAINT "grid_cell_runs_table_id_organization_id_grid_tables_id_organization_id_fk" FOREIGN KEY ("table_id","organization_id") REFERENCES "public"."grid_tables"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grid_cell_runs" ADD CONSTRAINT "grid_cell_runs_row_id_organization_id_grid_rows_id_organization_id_fk" FOREIGN KEY ("row_id","organization_id") REFERENCES "public"."grid_rows"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grid_columns" ADD CONSTRAINT "grid_columns_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grid_columns" ADD CONSTRAINT "grid_columns_table_id_organization_id_grid_tables_id_organization_id_fk" FOREIGN KEY ("table_id","organization_id") REFERENCES "public"."grid_tables"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grid_folders" ADD CONSTRAINT "grid_folders_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grid_folders" ADD CONSTRAINT "grid_folders_parent_id_organization_id_grid_folders_id_organization_id_fk" FOREIGN KEY ("parent_id","organization_id") REFERENCES "public"."grid_folders"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grid_jobs" ADD CONSTRAINT "grid_jobs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grid_jobs" ADD CONSTRAINT "grid_jobs_table_id_organization_id_grid_tables_id_organization_id_fk" FOREIGN KEY ("table_id","organization_id") REFERENCES "public"."grid_tables"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grid_jobs" ADD CONSTRAINT "grid_jobs_row_id_organization_id_grid_rows_id_organization_id_fk" FOREIGN KEY ("row_id","organization_id") REFERENCES "public"."grid_rows"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grid_provider_credentials" ADD CONSTRAINT "grid_provider_credentials_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grid_provider_credentials" ADD CONSTRAINT "grid_provider_credentials_provider_id_organization_id_grid_providers_id_organization_id_fk" FOREIGN KEY ("provider_id","organization_id") REFERENCES "public"."grid_providers"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grid_providers" ADD CONSTRAINT "grid_providers_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grid_rows" ADD CONSTRAINT "grid_rows_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grid_rows" ADD CONSTRAINT "grid_rows_table_id_organization_id_grid_tables_id_organization_id_fk" FOREIGN KEY ("table_id","organization_id") REFERENCES "public"."grid_tables"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grid_tables" ADD CONSTRAINT "grid_tables_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grid_tables" ADD CONSTRAINT "grid_tables_workbook_id_organization_id_grid_workbooks_id_organization_id_fk" FOREIGN KEY ("workbook_id","organization_id") REFERENCES "public"."grid_workbooks"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grid_user_views" ADD CONSTRAINT "grid_user_views_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grid_user_views" ADD CONSTRAINT "grid_user_views_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grid_user_views" ADD CONSTRAINT "grid_user_views_table_id_organization_id_grid_tables_id_organization_id_fk" FOREIGN KEY ("table_id","organization_id") REFERENCES "public"."grid_tables"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grid_workbooks" ADD CONSTRAINT "grid_workbooks_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grid_workbooks" ADD CONSTRAINT "grid_workbooks_folder_id_organization_id_grid_folders_id_organization_id_fk" FOREIGN KEY ("folder_id","organization_id") REFERENCES "public"."grid_folders"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deal_stages" ADD CONSTRAINT "deal_stages_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deals" ADD CONSTRAINT "deals_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deals" ADD CONSTRAINT "deals_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deals" ADD CONSTRAINT "deals_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deals" ADD CONSTRAINT "deals_person_fk" FOREIGN KEY ("person_id","organization_id") REFERENCES "public"."people"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deals" ADD CONSTRAINT "deals_stage_fk" FOREIGN KEY ("stage_id","organization_id","stage_kind") REFERENCES "public"."deal_stages"("id","organization_id","kind") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "deals" ADD CONSTRAINT "deals_source_enrollment_fk" FOREIGN KEY ("source_enrollment_id","organization_id") REFERENCES "public"."campaign_enrollments"("id","organization_id") ON DELETE SET NULL ("source_enrollment_id") ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "accounts_user_id_idx" ON "accounts" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "oauth_consents_grant_idx" ON "oauth_consents" USING btree ("client_id","user_id","reference_id");--> statement-breakpoint
CREATE INDEX "oauth_refresh_tokens_grant_idx" ON "oauth_refresh_tokens" USING btree ("client_id","user_id","reference_id");--> statement-breakpoint
CREATE INDEX "sessions_user_id_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "verifications_identifier_idx" ON "verifications" USING btree ("identifier");--> statement-breakpoint
CREATE INDEX "audit_log_org_created_idx" ON "audit_log" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_log_org_action_idx" ON "audit_log" USING btree ("organization_id","action","created_at");--> statement-breakpoint
CREATE INDEX "invitations_organization_id_idx" ON "invitations" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "invitations_email_idx" ON "invitations" USING btree ("email");--> statement-breakpoint
CREATE INDEX "mcp_agent_usage_day_idx" ON "mcp_agent_usage" USING btree ("day");--> statement-breakpoint
CREATE INDEX "mcp_tokens_org_user_idx" ON "mcp_tokens" USING btree ("organization_id","user_id");--> statement-breakpoint
CREATE INDEX "mcp_tool_calls_org_created_idx" ON "mcp_tool_calls" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "mcp_tool_calls_created_idx" ON "mcp_tool_calls" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "members_user_id_idx" ON "members" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "company_domain_aliases_org_company_idx" ON "company_domain_aliases" USING btree ("organization_id","company_id");--> statement-breakpoint
CREATE INDEX "contact_policies_org_dnc_idx" ON "contact_policies" USING btree ("organization_id") WHERE "contact_policies"."do_not_contact";--> statement-breakpoint
CREATE INDEX "import_runs_org_created_idx" ON "import_runs" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "people_org_email_uq" ON "people" USING btree ("organization_id",lower("email")) WHERE "people"."email" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "people_org_linkedin_uq" ON "people" USING btree ("organization_id","linkedin_slug") WHERE "people"."linkedin_slug" is not null;--> statement-breakpoint
CREATE INDEX "people_org_company_idx" ON "people" USING btree ("organization_id","company_id");--> statement-breakpoint
CREATE INDEX "people_org_created_idx" ON "people" USING btree ("organization_id","created_at","id");--> statement-breakpoint
CREATE INDEX "people_org_name_idx" ON "people" USING btree ("organization_id",lower("full_name"),"id");--> statement-breakpoint
CREATE INDEX "people_org_contacts_idx" ON "people" USING btree ("organization_id","converted_at" DESC NULLS FIRST,"id") WHERE "people"."lifecycle" = 'contact';--> statement-breakpoint
CREATE UNIQUE INDEX "people_creation_key_uq" ON "people" USING btree ("organization_id","creation_key") WHERE "people"."creation_key" is not null;--> statement-breakpoint
CREATE INDEX "campaign_enrollments_agent_idx" ON "campaign_enrollments" USING btree ("organization_id","created_at") WHERE "campaign_enrollments"."enrolled_via_token_id" is not null;--> statement-breakpoint
CREATE INDEX "enrollments_due_idx" ON "campaign_enrollments" USING btree ("channel","next_send_at") WHERE "campaign_enrollments"."status" = 'active';--> statement-breakpoint
CREATE INDEX "enrollments_person_idx" ON "campaign_enrollments" USING btree ("person_id");--> statement-breakpoint
CREATE UNIQUE INDEX "campaign_senders_mailbox_uq" ON "campaign_senders" USING btree ("campaign_id","mailbox_id") WHERE "campaign_senders"."mailbox_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "campaign_senders_linkedin_uq" ON "campaign_senders" USING btree ("campaign_id","linkedin_account_id") WHERE "campaign_senders"."linkedin_account_id" is not null;--> statement-breakpoint
CREATE INDEX "campaigns_org_status_idx" ON "campaigns" USING btree ("organization_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "inbound_events_provider_key_uq" ON "inbound_events" USING btree ("provider","provider_event_key") WHERE "inbound_events"."provider_event_key" is not null;--> statement-breakpoint
CREATE INDEX "inbound_events_claim_idx" ON "inbound_events" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "inbound_events_org_status_idx" ON "inbound_events" USING btree ("organization_id","provider","status","created_at");--> statement-breakpoint
CREATE INDEX "linkedin_connect_links_org_idx" ON "linkedin_connect_links" USING btree ("organization_id","status","created_at");--> statement-breakpoint
CREATE INDEX "linkedin_details_resolve_idx" ON "linkedin_enrollment_details" USING btree ("resolve_next_attempt_at");--> statement-breakpoint
CREATE INDEX "linkedin_search_batches_org_created_idx" ON "linkedin_search_batches" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "linkedin_search_queries_claim_idx" ON "linkedin_search_queries" USING btree ("status","lease_until");--> statement-breakpoint
CREATE UNIQUE INDEX "linkedin_search_queries_batch_url_uq" ON "linkedin_search_queries" USING btree ("batch_id","url");--> statement-breakpoint
CREATE INDEX "linkedin_search_queries_batch_idx" ON "linkedin_search_queries" USING btree ("batch_id","status");--> statement-breakpoint
CREATE INDEX "linkedin_search_queries_org_created_idx" ON "linkedin_search_queries" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "mailboxes_org_idx" ON "mailboxes" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "sends_mailbox_test_idx" ON "sends" USING btree ("mailbox_id","claimed_at") WHERE "sends"."kind" = 'test';--> statement-breakpoint
CREATE INDEX "sends_mailbox_day_idx" ON "sends" USING btree ("mailbox_id","claimed_at");--> statement-breakpoint
CREATE INDEX "sends_linkedin_day_idx" ON "sends" USING btree ("linkedin_account_id","claimed_at");--> statement-breakpoint
CREATE INDEX "sends_org_status_idx" ON "sends" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "sends_uncertain_due_idx" ON "sends" USING btree ("channel",coalesce("next_check_at", "claimed_at")) WHERE "sends"."status" in ('sending', 'unknown');--> statement-breakpoint
CREATE UNIQUE INDEX "sends_rfc_message_uq" ON "sends" USING btree ("rfc_message_id") WHERE "sends"."rfc_message_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "sends_provider_message_uq" ON "sends" USING btree ("channel","provider_message_id") WHERE "sends"."provider_message_id" is not null;--> statement-breakpoint
CREATE INDEX "ai_jobs_claim_idx" ON "ai_jobs" USING btree ("status","run_after","priority");--> statement-breakpoint
CREATE INDEX "ai_jobs_stale_lock_idx" ON "ai_jobs" USING btree ("status","locked_at");--> statement-breakpoint
CREATE INDEX "ai_jobs_org_failed_idx" ON "ai_jobs" USING btree ("organization_id","failed_at") WHERE "ai_jobs"."status" = 'failed';--> statement-breakpoint
CREATE INDEX "conversations_private_idx" ON "conversations" USING btree ("organization_id","private_campaign_id") WHERE "conversations"."private_campaign_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "conversations_org_thread_uq" ON "conversations" USING btree ("organization_id","channel","account_ref","provider_thread_id") WHERE "conversations"."provider_thread_id" is not null;--> statement-breakpoint
CREATE INDEX "conversations_record_idx" ON "conversations" USING btree ("record_id");--> statement-breakpoint
CREATE INDEX "drafts_record_status_idx" ON "drafts" USING btree ("record_id","status");--> statement-breakpoint
CREATE INDEX "drafts_reply_for_message_idx" ON "drafts" USING btree ("reply_for_message_id") WHERE "drafts"."reply_for_message_id" is not null;--> statement-breakpoint
CREATE INDEX "drafts_conversation_idx" ON "drafts" USING btree ("conversation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "drafts_one_in_flight_uq" ON "drafts" USING btree ("conversation_id") WHERE "drafts"."status" in ('sending', 'delivery_uncertain');--> statement-breakpoint
CREATE INDEX "events_record_idx" ON "events" USING btree ("record_id","created_at");--> statement-breakpoint
CREATE INDEX "events_person_created_idx" ON "events" USING btree ("person_id","created_at");--> statement-breakpoint
CREATE INDEX "identity_exceptions_org_status_created_idx" ON "identity_exceptions" USING btree ("organization_id","status","created_at");--> statement-breakpoint
CREATE INDEX "knowledge_documents_org_active_idx" ON "knowledge_documents" USING btree ("organization_id","active","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "lead_ccs_person_email_uq" ON "lead_ccs" USING btree ("person_id","email");--> statement-breakpoint
CREATE INDEX "lead_ccs_org_email_idx" ON "lead_ccs" USING btree ("organization_id","email");--> statement-breakpoint
CREATE INDEX "lead_ccs_source_message_idx" ON "lead_ccs" USING btree ("source_message_id") WHERE "lead_ccs"."source_message_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "messages_org_idempotency_uq" ON "messages" USING btree ("organization_id","channel","account_ref","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "messages_org_provider_id_uq" ON "messages" USING btree ("organization_id","channel","account_ref","provider_message_id") WHERE "messages"."provider_message_id" is not null;--> statement-breakpoint
CREATE INDEX "messages_conversation_sent_idx" ON "messages" USING btree ("conversation_id","sent_at");--> statement-breakpoint
CREATE INDEX "messages_org_direction_sent_idx" ON "messages" USING btree ("organization_id","direction","sent_at");--> statement-breakpoint
CREATE INDEX "notes_person_idx" ON "notes" USING btree ("person_id","created_at");--> statement-breakpoint
CREATE INDEX "records_org_assigned_idx" ON "records" USING btree ("organization_id","assigned_to","workflow_state");--> statement-breakpoint
CREATE INDEX "records_org_state_idx" ON "records" USING btree ("organization_id","workflow_state","last_interaction_at");--> statement-breakpoint
CREATE INDEX "records_latest_inbound_message_idx" ON "records" USING btree ("latest_inbound_message_id") WHERE "records"."latest_inbound_message_id" is not null;--> statement-breakpoint
CREATE INDEX "reply_type_picks_record_created_idx" ON "reply_type_picks" USING btree ("record_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "reply_type_sets_one_default_uq" ON "reply_type_sets" USING btree ("organization_id") WHERE "reply_type_sets"."is_default";--> statement-breakpoint
CREATE UNIQUE INDEX "reply_types_set_system_role_uq" ON "reply_types" USING btree ("reply_type_set_id","system_role") WHERE "reply_types"."system_role" is not null;--> statement-breakpoint
CREATE INDEX "send_attempts_agent_org_idx" ON "send_attempts" USING btree ("organization_id","created_at") WHERE "send_attempts"."origin" = 'agent';--> statement-breakpoint
CREATE INDEX "send_attempts_agent_user_idx" ON "send_attempts" USING btree ("organization_id","actor_user_id","created_at") WHERE "send_attempts"."origin" = 'agent';--> statement-breakpoint
CREATE INDEX "send_attempts_agent_account_idx" ON "send_attempts" USING btree ("organization_id","account_ref","created_at") WHERE "send_attempts"."origin" = 'agent';--> statement-breakpoint
CREATE UNIQUE INDEX "send_attempts_one_terminal_uq" ON "send_attempts" USING btree ("draft_id") WHERE "send_attempts"."status" in ('sent', 'delivery_uncertain', 'reconciled');--> statement-breakpoint
CREATE INDEX "send_attempts_draft_created_idx" ON "send_attempts" USING btree ("draft_id","created_at");--> statement-breakpoint
CREATE INDEX "stop_reviews_org_idx" ON "stop_reviews" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "tasks_person_idx" ON "tasks" USING btree ("person_id","is_completed");--> statement-breakpoint
CREATE INDEX "tasks_org_open_due_idx" ON "tasks" USING btree ("organization_id","due_at") WHERE not "tasks"."is_completed";--> statement-breakpoint
CREATE INDEX "tasks_assignee_open_idx" ON "tasks" USING btree ("assigned_to","due_at") WHERE not "tasks"."is_completed";--> statement-breakpoint
CREATE UNIQUE INDEX "sequence_runs_one_active_uq" ON "sequence_runs" USING btree ("record_id") WHERE "sequence_runs"."status" = 'active';--> statement-breakpoint
CREATE INDEX "sequence_runs_record_created_idx" ON "sequence_runs" USING btree ("record_id","created_at");--> statement-breakpoint
CREATE INDEX "sequence_runs_trigger_message_idx" ON "sequence_runs" USING btree ("trigger_message_id");--> statement-breakpoint
CREATE INDEX "sequence_runs_conversation_idx" ON "sequence_runs" USING btree ("conversation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sequence_step_runs_draft_uq" ON "sequence_step_runs" USING btree ("draft_id") WHERE "sequence_step_runs"."draft_id" is not null;--> statement-breakpoint
CREATE INDEX "sequence_step_runs_due_idx" ON "sequence_step_runs" USING btree ("status","due_at");--> statement-breakpoint
CREATE INDEX "sequence_step_runs_sent_message_idx" ON "sequence_step_runs" USING btree ("sent_message_id") WHERE "sequence_step_runs"."sent_message_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "sequence_versions_one_draft_uq" ON "sequence_versions" USING btree ("sequence_id") WHERE "sequence_versions"."status" = 'draft';--> statement-breakpoint
CREATE UNIQUE INDEX "sequences_org_name_uq" ON "sequences" USING btree ("organization_id","name") WHERE "sequences"."campaign_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "sequences_campaign_uq" ON "sequences" USING btree ("campaign_id") WHERE "sequences"."campaign_id" is not null;--> statement-breakpoint
CREATE INDEX "sequences_org_status_idx" ON "sequences" USING btree ("organization_id","status","name");--> statement-breakpoint
CREATE INDEX "grid_cell_runs_cell_idx" ON "grid_cell_runs" USING btree ("row_id","column_key");--> statement-breakpoint
CREATE INDEX "grid_cell_runs_table_created_idx" ON "grid_cell_runs" USING btree ("table_id","created_at");--> statement-breakpoint
CREATE INDEX "grid_cell_runs_lookup_idx" ON "grid_cell_runs" USING btree ("organization_id","lookup_key","created_at") WHERE "grid_cell_runs"."lookup_key" is not null;--> statement-breakpoint
CREATE INDEX "grid_columns_table_pos_idx" ON "grid_columns" USING btree ("table_id","position");--> statement-breakpoint
CREATE INDEX "grid_folders_org_parent_idx" ON "grid_folders" USING btree ("organization_id","parent_id");--> statement-breakpoint
CREATE INDEX "grid_jobs_claim_idx" ON "grid_jobs" USING btree ("status","run_after","priority");--> statement-breakpoint
CREATE INDEX "grid_jobs_table_status_idx" ON "grid_jobs" USING btree ("table_id","status");--> statement-breakpoint
CREATE INDEX "grid_jobs_org_status_idx" ON "grid_jobs" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "grid_rows_table_pos_idx" ON "grid_rows" USING btree ("table_id","position");--> statement-breakpoint
CREATE INDEX "grid_rows_table_version_idx" ON "grid_rows" USING btree ("table_id","version");--> statement-breakpoint
CREATE INDEX "grid_tables_workbook_pos_idx" ON "grid_tables" USING btree ("workbook_id","position");--> statement-breakpoint
CREATE INDEX "grid_workbooks_org_folder_idx" ON "grid_workbooks" USING btree ("organization_id","folder_id");--> statement-breakpoint
CREATE UNIQUE INDEX "deal_stages_org_name_uq" ON "deal_stages" USING btree ("organization_id",lower("name"));--> statement-breakpoint
CREATE UNIQUE INDEX "deals_idempotency_uq" ON "deals" USING btree ("organization_id","person_id","idempotency_key") WHERE "deals"."idempotency_key" is not null;--> statement-breakpoint
CREATE INDEX "deals_org_stage_idx" ON "deals" USING btree ("organization_id","stage_id","stage_changed_at" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "deals_org_person_idx" ON "deals" USING btree ("organization_id","person_id");--> statement-breakpoint
-- ---- Written by hand below this marker: the foreign keys schema.ts leaves out (circular references), then the
-- functions and the triggers they back.

ALTER TABLE ONLY public.knowledge_documents
    ADD CONSTRAINT knowledge_documents_latest_version_fk FOREIGN KEY (id, latest_version) REFERENCES public.knowledge_document_versions(document_id, version) DEFERRABLE INITIALLY DEFERRED;--> statement-breakpoint

ALTER TABLE ONLY public.records
    ADD CONSTRAINT records_latest_inbound_message_fk FOREIGN KEY (latest_inbound_message_id, organization_id) REFERENCES public.messages(id, organization_id) ON DELETE SET NULL (latest_inbound_message_id);--> statement-breakpoint

CREATE FUNCTION public.campaign_enrollments_reject_contact() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
	person_lifecycle text;
BEGIN
	-- FOR SHARE: an enrollment that races a conversion waits for it, then sees 'contact'.
	SELECT p.lifecycle INTO person_lifecycle FROM people p WHERE p.id = NEW.person_id AND p.organization_id = NEW.organization_id FOR SHARE;
	IF person_lifecycle = 'contact' THEN
		RAISE EXCEPTION 'contact_cannot_be_enrolled'
			USING ERRCODE = 'check_violation', TABLE = 'campaign_enrollments', COLUMN = 'person_id';
	END IF;
	RETURN NEW;
END $$;--> statement-breakpoint

CREATE FUNCTION public.companies_reject_alias_domain() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
	IF EXISTS (SELECT 1 FROM company_domain_aliases a WHERE a.organization_id = NEW.organization_id AND a.domain = NEW.domain) THEN
		RAISE EXCEPTION 'companies.domain % is another domain of a company in this organization', NEW.domain
			USING ERRCODE = 'unique_violation', CONSTRAINT = 'company_domain_is_alias', TABLE = 'companies', COLUMN = 'domain';
	END IF;
	RETURN NEW;
END $$;--> statement-breakpoint

CREATE FUNCTION public.company_aliases_reject_company_domain() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
	IF EXISTS (SELECT 1 FROM companies c WHERE c.organization_id = NEW.organization_id AND c.domain = NEW.domain) THEN
		RAISE EXCEPTION 'company_domain_aliases.domain % is the domain of a company in this organization', NEW.domain
			USING ERRCODE = 'unique_violation', CONSTRAINT = 'alias_is_company_domain', TABLE = 'company_domain_aliases', COLUMN = 'domain';
	END IF;
	RETURN NEW;
END $$;--> statement-breakpoint

CREATE FUNCTION public.conversations_reject_identity_change() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
	RAISE EXCEPTION 'conversations identity is immutable: channel, account_ref, provider_thread_id and provider_contact_id cannot change'
		USING ERRCODE = 'integrity_constraint_violation', TABLE = 'conversations';
END $$;--> statement-breakpoint

CREATE FUNCTION public.deal_stages_reject_kind_change() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
	RAISE EXCEPTION 'deal_stages.kind is immutable: create a new stage instead'
		USING ERRCODE = 'integrity_constraint_violation', TABLE = 'deal_stages', COLUMN = 'kind';
END $$;--> statement-breakpoint

CREATE FUNCTION public.deals_reject_person_change() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
	RAISE EXCEPTION 'deals.person_id and deals.organization_id are immutable'
		USING ERRCODE = 'integrity_constraint_violation', TABLE = 'deals', COLUMN = 'person_id';
END $$;--> statement-breakpoint

CREATE FUNCTION public.deals_require_contact() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
	person_lifecycle text;
BEGIN
	SELECT p.lifecycle INTO person_lifecycle FROM people p WHERE p.id = NEW.person_id AND p.organization_id = NEW.organization_id;
	IF person_lifecycle IS NOT NULL AND person_lifecycle <> 'contact' THEN
		RAISE EXCEPTION 'deals.person_id must be a contact: convert the lead first'
			USING ERRCODE = 'integrity_constraint_violation', TABLE = 'deals', COLUMN = 'person_id';
	END IF;
	RETURN NEW;
END $$;--> statement-breakpoint

CREATE FUNCTION public.drafts_validate_channel() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
	conversation_channel text;
BEGIN
	SELECT c.channel INTO conversation_channel FROM conversations c WHERE c.id = NEW.conversation_id AND c.organization_id = NEW.organization_id;
	IF conversation_channel IS NOT NULL AND conversation_channel <> NEW.channel THEN
		RAISE EXCEPTION 'drafts.channel (%) must equal the channel of its conversation (%)', NEW.channel, conversation_channel
			USING ERRCODE = 'integrity_constraint_violation', TABLE = 'drafts', COLUMN = 'channel';
	END IF;
	RETURN NEW;
END $$;--> statement-breakpoint

CREATE FUNCTION public.drafts_validate_reply_target() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
	target_direction text;
	target_record uuid;
BEGIN
	IF NEW.reply_for_message_id IS NULL THEN
		RETURN NEW;
	END IF;
	SELECT m.direction, cv.record_id INTO target_direction, target_record
	FROM messages m JOIN conversations cv ON cv.id = m.conversation_id AND cv.organization_id = m.organization_id
	WHERE m.id = NEW.reply_for_message_id AND m.organization_id = NEW.organization_id;
	-- A message that does not exist in the organization is left to the foreign key (drafts_reply_message_fk).
	IF NOT FOUND THEN
		RETURN NEW;
	END IF;
	IF target_direction <> 'inbound' THEN
		RAISE EXCEPTION 'drafts.reply_for_message_id must be an inbound message'
			USING ERRCODE = 'integrity_constraint_violation', TABLE = 'drafts', COLUMN = 'reply_for_message_id';
	END IF;
	IF target_record <> NEW.record_id THEN
		RAISE EXCEPTION 'drafts.reply_for_message_id must be a message of the draft''s record'
			USING ERRCODE = 'integrity_constraint_violation', TABLE = 'drafts', COLUMN = 'reply_for_message_id';
	END IF;
	RETURN NEW;
END $$;--> statement-breakpoint

CREATE FUNCTION public.grid_rows_bump_version() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
	NEW.version := nextval('grid_row_version_seq');
	RETURN NEW;
END $$;--> statement-breakpoint

CREATE FUNCTION public.knowledge_versions_reject_update() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
	RAISE EXCEPTION 'knowledge_document_versions is append-only: rows cannot be updated, insert a new version instead'
		USING ERRCODE = 'integrity_constraint_violation', TABLE = 'knowledge_document_versions';
END $$;--> statement-breakpoint

CREATE FUNCTION public.ledger_reject_delete() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
	IF pg_trigger_depth() > 1 OR current_setting('miasdr.allow_purge', true) = 'on' THEN
		RETURN OLD;
	END IF;
	RAISE EXCEPTION '% is append-only: rows cannot be deleted directly (set miasdr.allow_purge to on inside a transaction to purge)', TG_TABLE_NAME
		USING ERRCODE = 'integrity_constraint_violation', TABLE = TG_TABLE_NAME;
END $$;--> statement-breakpoint

CREATE FUNCTION public.ledger_reject_update() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
	IF pg_trigger_depth() > 1 AND NEW.actor_user_id IS NULL AND OLD.actor_user_id IS NOT NULL
		AND (to_jsonb(NEW) - 'actor_user_id') = (to_jsonb(OLD) - 'actor_user_id') THEN
		RETURN NEW;
	END IF;
	RAISE EXCEPTION '% is append-only: rows cannot be updated', TG_TABLE_NAME
		USING ERRCODE = 'integrity_constraint_violation', TABLE = TG_TABLE_NAME;
END $$;--> statement-breakpoint

CREATE FUNCTION public.messages_reject_immutable_update() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
	IF NEW."id" IS DISTINCT FROM OLD."id"
		OR NEW."organization_id" IS DISTINCT FROM OLD."organization_id"
		OR NEW."conversation_id" IS DISTINCT FROM OLD."conversation_id"
		OR NEW."channel" IS DISTINCT FROM OLD."channel"
		OR NEW."account_ref" IS DISTINCT FROM OLD."account_ref"
		OR NEW."direction" IS DISTINCT FROM OLD."direction"
		OR NEW."idempotency_key" IS DISTINCT FROM OLD."idempotency_key"
		OR NEW."provider_message_id" IS DISTINCT FROM OLD."provider_message_id"
		OR NEW."subject" IS DISTINCT FROM OLD."subject"
		OR NEW."from_address" IS DISTINCT FROM OLD."from_address"
		OR NEW."to_address" IS DISTINCT FROM OLD."to_address"
		OR NEW."cc" IS DISTINCT FROM OLD."cc"
		OR NEW."body_text" IS DISTINCT FROM OLD."body_text"
		OR NEW."raw" IS DISTINCT FROM OLD."raw"
		OR NEW."sent_at" IS DISTINCT FROM OLD."sent_at"
		OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
		RAISE EXCEPTION 'messages is append-only: only important and opened_at can change'
			USING ERRCODE = 'integrity_constraint_violation', TABLE = 'messages';
	END IF;
	RETURN NEW;
END $$;--> statement-breakpoint

CREATE FUNCTION public.people_reject_lifecycle_change() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
	IF OLD.lifecycle = 'contact' AND NEW.lifecycle IS DISTINCT FROM 'contact' THEN
		RAISE EXCEPTION 'people.lifecycle cannot change from contact: a contact never becomes a lead again'
			USING ERRCODE = 'integrity_constraint_violation', TABLE = 'people', COLUMN = 'lifecycle';
	END IF;
	IF OLD.converted_at IS NOT NULL AND NEW.converted_at IS DISTINCT FROM OLD.converted_at THEN
		RAISE EXCEPTION 'people.converted_at cannot change once set'
			USING ERRCODE = 'integrity_constraint_violation', TABLE = 'people', COLUMN = 'converted_at';
	END IF;
	RETURN NEW;
END $$;--> statement-breakpoint

CREATE FUNCTION public.reply_type_pick_type_fits(org uuid, type_set uuid, type_id uuid, grp text) RETURNS boolean
    LANGUAGE sql STABLE
    AS $$
	-- A reply type that does not exist in the organization is left to the foreign key.
	SELECT type_id IS NULL
		OR NOT EXISTS (SELECT 1 FROM reply_types t WHERE t.id = type_id AND t.organization_id = org)
		OR EXISTS (
			SELECT 1 FROM reply_types t
			WHERE t.id = type_id AND t.organization_id = org AND t.reply_type_set_id = type_set AND (grp IS NULL OR t.group_key = grp));
$$;--> statement-breakpoint

CREATE FUNCTION public.reply_type_picks_validate_message() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
	-- A message that does not exist in the organization is left to the foreign key, which names its own constraint.
	IF EXISTS (SELECT 1 FROM messages m WHERE m.id = NEW.message_id AND m.organization_id = NEW.organization_id) AND NOT EXISTS (
		SELECT 1 FROM messages m JOIN conversations c ON c.id = m.conversation_id AND c.organization_id = m.organization_id
		WHERE m.id = NEW.message_id AND m.organization_id = NEW.organization_id AND m.direction = 'inbound' AND c.record_id = NEW.record_id
	) THEN
		RAISE EXCEPTION 'reply_type_picks.message_id must be an inbound message of the pick''s record'
			USING ERRCODE = 'integrity_constraint_violation', TABLE = 'reply_type_picks', COLUMN = 'message_id';
	END IF;
	RETURN NEW;
END $$;--> statement-breakpoint

CREATE FUNCTION public.reply_type_picks_validate_reply_types() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
	type_set uuid;
	moved boolean := TG_OP = 'INSERT';
BEGIN
	IF TG_OP = 'UPDATE' THEN moved := OLD.record_id IS DISTINCT FROM NEW.record_id; END IF;
	SELECT r.reply_type_set_id INTO type_set FROM records r WHERE r.id = NEW.record_id AND r.organization_id = NEW.organization_id;
	IF type_set IS NULL THEN RETURN NEW; END IF; -- the record foreign key reports a missing record
	IF (moved OR NEW.previous_reply_type_id IS DISTINCT FROM OLD.previous_reply_type_id OR NEW.previous_group_key IS DISTINCT FROM OLD.previous_group_key)
		AND NOT reply_type_pick_type_fits(NEW.organization_id, type_set, NEW.previous_reply_type_id, NEW.previous_group_key) THEN
		RAISE EXCEPTION 'reply_type_picks.previous_reply_type_id must belong to the record''s reply type set and to previous_group_key'
			USING ERRCODE = 'integrity_constraint_violation', TABLE = 'reply_type_picks', COLUMN = 'previous_reply_type_id';
	END IF;
	IF (moved OR NEW.proposed_reply_type_id IS DISTINCT FROM OLD.proposed_reply_type_id OR NEW.proposed_group_key IS DISTINCT FROM OLD.proposed_group_key)
		AND NOT reply_type_pick_type_fits(NEW.organization_id, type_set, NEW.proposed_reply_type_id, NEW.proposed_group_key) THEN
		RAISE EXCEPTION 'reply_type_picks.proposed_reply_type_id must belong to the record''s reply type set and to proposed_group_key'
			USING ERRCODE = 'integrity_constraint_violation', TABLE = 'reply_type_picks', COLUMN = 'proposed_reply_type_id';
	END IF;
	IF (moved OR NEW.applied_reply_type_id IS DISTINCT FROM OLD.applied_reply_type_id OR NEW.applied_group_key IS DISTINCT FROM OLD.applied_group_key)
		AND NOT reply_type_pick_type_fits(NEW.organization_id, type_set, NEW.applied_reply_type_id, NEW.applied_group_key) THEN
		RAISE EXCEPTION 'reply_type_picks.applied_reply_type_id must belong to the record''s reply type set and to applied_group_key'
			USING ERRCODE = 'integrity_constraint_violation', TABLE = 'reply_type_picks', COLUMN = 'applied_reply_type_id';
	END IF;
	RETURN NEW;
END $$;--> statement-breakpoint

CREATE FUNCTION public.reply_types_reject_key_change() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
	RAISE EXCEPTION 'reply_types keys are immutable: key, group_key, reply_type_set_id and system_role cannot change'
		USING ERRCODE = 'integrity_constraint_violation', TABLE = 'reply_types';
END $$;--> statement-breakpoint

CREATE FUNCTION public.send_attempts_reject_final_status_change() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
	IF NEW.status IS DISTINCT FROM OLD.status AND OLD.status IN ('sent', 'reconciled', 'failed') THEN
		RAISE EXCEPTION 'send_attempts status % is final and cannot change to %', OLD.status, NEW.status
			USING ERRCODE = 'check_violation', TABLE = 'send_attempts';
	END IF;
	RETURN NEW;
END $$;--> statement-breakpoint

CREATE FUNCTION public.send_attempts_validate_account() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
	conversation_account text;
BEGIN
	-- A blank value is left to send_attempts_refs_ck, which names its own constraint.
	IF NEW.account_ref IS NULL OR length(btrim(NEW.account_ref)) = 0 THEN RETURN NEW; END IF;
	SELECT c.account_ref INTO conversation_account
	FROM drafts d JOIN conversations c ON c.id = d.conversation_id AND c.organization_id = d.organization_id
	WHERE d.id = NEW.draft_id AND d.organization_id = NEW.organization_id;
	IF conversation_account IS NOT NULL AND lower(conversation_account) <> lower(NEW.account_ref) THEN
		RAISE EXCEPTION 'send_attempts.account_ref (%) must equal the account of the draft''s conversation (%)', NEW.account_ref, conversation_account
			USING ERRCODE = 'integrity_constraint_violation', TABLE = 'send_attempts', COLUMN = 'account_ref';
	END IF;
	RETURN NEW;
END $$;--> statement-breakpoint

CREATE FUNCTION public.sends_reject_final_status_change() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
	IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
		RETURN NEW;
	END IF;
	IF OLD.status = 'failed' AND NEW.status = 'sending' AND NEW.attempt = OLD.attempt + 1 THEN
		RETURN NEW;
	END IF;
	IF OLD.status IN ('sent', 'failed') THEN
		RAISE EXCEPTION 'sends status % is final and cannot change to %', OLD.status, NEW.status
			USING ERRCODE = 'check_violation', TABLE = 'sends';
	END IF;
	RETURN NEW;
END $$;--> statement-breakpoint

CREATE FUNCTION public.sends_reject_unsettled_delete() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
	IF pg_trigger_depth() > 1 THEN
		RETURN OLD;
	END IF;
	RAISE EXCEPTION 'sends row % is % and cannot be deleted until it settles', OLD.id, OLD.status
		USING ERRCODE = 'integrity_constraint_violation', TABLE = 'sends';
END $$;--> statement-breakpoint

CREATE FUNCTION public.sequence_steps_reject_published_change() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
	old_version uuid;
	new_version uuid;
	frozen boolean;
BEGIN
	IF TG_OP <> 'INSERT' THEN old_version := OLD.sequence_version_id; END IF;
	IF TG_OP <> 'DELETE' THEN new_version := NEW.sequence_version_id; END IF;
	IF TG_OP = 'DELETE' AND (pg_trigger_depth() > 1 OR current_setting('miasdr.allow_purge', true) = 'on') THEN
		RETURN OLD;
	END IF;
	SELECT EXISTS (SELECT 1 FROM sequence_versions v WHERE v.status = 'published' AND v.id IN (old_version, new_version)) INTO frozen;
	IF frozen THEN
		RAISE EXCEPTION 'sequence_steps of a published sequence version are frozen: edit a new draft instead'
			USING ERRCODE = 'integrity_constraint_violation', TABLE = 'sequence_steps';
	END IF;
	IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
	RETURN NEW;
END $$;--> statement-breakpoint

CREATE FUNCTION public.sequence_versions_reject_change() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
	IF OLD.organization_id IS DISTINCT FROM NEW.organization_id
		OR OLD.sequence_id IS DISTINCT FROM NEW.sequence_id
		OR OLD.version IS DISTINCT FROM NEW.version THEN
		RAISE EXCEPTION 'sequence_versions identity is immutable: organization_id, sequence_id and version cannot change'
			USING ERRCODE = 'integrity_constraint_violation', TABLE = 'sequence_versions';
	END IF;
	IF OLD.status = 'published' THEN
		RAISE EXCEPTION 'a published sequence version is frozen: status and published_at cannot change'
			USING ERRCODE = 'integrity_constraint_violation', TABLE = 'sequence_versions';
	END IF;
	RETURN NEW;
END $$;--> statement-breakpoint

CREATE FUNCTION public.sequence_versions_reject_delete() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
	IF pg_trigger_depth() > 1 OR current_setting('miasdr.allow_purge', true) = 'on' THEN
		RETURN OLD;
	END IF;
	RAISE EXCEPTION 'a published sequence version cannot be deleted directly (delete the sequence, or set miasdr.allow_purge to on inside a transaction)'
		USING ERRCODE = 'integrity_constraint_violation', TABLE = 'sequence_versions';
END $$;


SET default_tablespace = '';

SET default_table_access_method = heap;--> statement-breakpoint

CREATE TRIGGER audit_log_no_delete_trg BEFORE DELETE ON public.audit_log FOR EACH ROW EXECUTE FUNCTION public.ledger_reject_delete();--> statement-breakpoint

CREATE TRIGGER audit_log_no_update_trg BEFORE UPDATE ON public.audit_log FOR EACH ROW EXECUTE FUNCTION public.ledger_reject_update();--> statement-breakpoint

CREATE TRIGGER campaign_enrollments_contact_ins_trg BEFORE INSERT ON public.campaign_enrollments FOR EACH ROW WHEN ((new.status = ANY (ARRAY['pending'::text, 'active'::text]))) EXECUTE FUNCTION public.campaign_enrollments_reject_contact();--> statement-breakpoint

CREATE TRIGGER campaign_enrollments_contact_upd_trg BEFORE UPDATE OF status ON public.campaign_enrollments FOR EACH ROW WHEN (((new.status = ANY (ARRAY['pending'::text, 'active'::text])) AND (old.status <> ALL (ARRAY['pending'::text, 'active'::text])))) EXECUTE FUNCTION public.campaign_enrollments_reject_contact();--> statement-breakpoint

CREATE TRIGGER companies_domain_not_alias_trg BEFORE INSERT OR UPDATE OF domain ON public.companies FOR EACH ROW EXECUTE FUNCTION public.companies_reject_alias_domain();--> statement-breakpoint

CREATE TRIGGER company_aliases_not_domain_trg BEFORE INSERT OR UPDATE OF domain ON public.company_domain_aliases FOR EACH ROW EXECUTE FUNCTION public.company_aliases_reject_company_domain();--> statement-breakpoint

CREATE TRIGGER conversations_identity_trg BEFORE UPDATE OF channel, account_ref, provider_thread_id, provider_contact_id ON public.conversations FOR EACH ROW WHEN (((old.channel IS DISTINCT FROM new.channel) OR (old.account_ref IS DISTINCT FROM new.account_ref) OR (old.provider_thread_id IS DISTINCT FROM new.provider_thread_id) OR (old.provider_contact_id IS DISTINCT FROM new.provider_contact_id))) EXECUTE FUNCTION public.conversations_reject_identity_change();--> statement-breakpoint

CREATE TRIGGER deal_stages_kind_trg BEFORE UPDATE OF kind ON public.deal_stages FOR EACH ROW WHEN ((old.kind IS DISTINCT FROM new.kind)) EXECUTE FUNCTION public.deal_stages_reject_kind_change();--> statement-breakpoint

CREATE TRIGGER deals_contact_trg BEFORE INSERT ON public.deals FOR EACH ROW EXECUTE FUNCTION public.deals_require_contact();--> statement-breakpoint

CREATE TRIGGER deals_person_trg BEFORE UPDATE OF person_id, organization_id ON public.deals FOR EACH ROW WHEN (((old.person_id IS DISTINCT FROM new.person_id) OR (old.organization_id IS DISTINCT FROM new.organization_id))) EXECUTE FUNCTION public.deals_reject_person_change();--> statement-breakpoint

CREATE TRIGGER drafts_channel_ins_trg BEFORE INSERT ON public.drafts FOR EACH ROW EXECUTE FUNCTION public.drafts_validate_channel();--> statement-breakpoint

CREATE TRIGGER drafts_channel_upd_trg BEFORE UPDATE OF channel, conversation_id ON public.drafts FOR EACH ROW WHEN (((old.channel IS DISTINCT FROM new.channel) OR (old.conversation_id IS DISTINCT FROM new.conversation_id))) EXECUTE FUNCTION public.drafts_validate_channel();--> statement-breakpoint

CREATE TRIGGER drafts_reply_target_ins_trg BEFORE INSERT ON public.drafts FOR EACH ROW EXECUTE FUNCTION public.drafts_validate_reply_target();--> statement-breakpoint

CREATE TRIGGER drafts_reply_target_upd_trg BEFORE UPDATE OF reply_for_message_id, record_id ON public.drafts FOR EACH ROW WHEN (((old.reply_for_message_id IS DISTINCT FROM new.reply_for_message_id) OR (old.record_id IS DISTINCT FROM new.record_id))) EXECUTE FUNCTION public.drafts_validate_reply_target();--> statement-breakpoint

CREATE TRIGGER events_no_delete_trg BEFORE DELETE ON public.events FOR EACH ROW EXECUTE FUNCTION public.ledger_reject_delete();--> statement-breakpoint

CREATE TRIGGER events_no_update_trg BEFORE UPDATE ON public.events FOR EACH ROW EXECUTE FUNCTION public.ledger_reject_update();--> statement-breakpoint

CREATE TRIGGER grid_rows_bump_version_trg BEFORE UPDATE OF cells, cell_meta ON public.grid_rows FOR EACH ROW EXECUTE FUNCTION public.grid_rows_bump_version();--> statement-breakpoint

CREATE TRIGGER knowledge_versions_no_delete_trg BEFORE DELETE ON public.knowledge_document_versions FOR EACH ROW EXECUTE FUNCTION public.ledger_reject_delete();--> statement-breakpoint

CREATE TRIGGER knowledge_versions_no_update_trg BEFORE UPDATE ON public.knowledge_document_versions FOR EACH ROW WHEN ((old.* IS DISTINCT FROM new.*)) EXECUTE FUNCTION public.knowledge_versions_reject_update();--> statement-breakpoint

CREATE TRIGGER messages_immutable_trg BEFORE UPDATE ON public.messages FOR EACH ROW EXECUTE FUNCTION public.messages_reject_immutable_update();--> statement-breakpoint

CREATE TRIGGER messages_no_delete_trg BEFORE DELETE ON public.messages FOR EACH ROW EXECUTE FUNCTION public.ledger_reject_delete();--> statement-breakpoint

CREATE TRIGGER people_lifecycle_trg BEFORE UPDATE OF lifecycle, converted_at ON public.people FOR EACH ROW WHEN (((old.lifecycle IS DISTINCT FROM new.lifecycle) OR (old.converted_at IS DISTINCT FROM new.converted_at))) EXECUTE FUNCTION public.people_reject_lifecycle_change();--> statement-breakpoint

CREATE TRIGGER reply_type_picks_message_ins_trg BEFORE INSERT ON public.reply_type_picks FOR EACH ROW EXECUTE FUNCTION public.reply_type_picks_validate_message();--> statement-breakpoint

CREATE TRIGGER reply_type_picks_message_upd_trg BEFORE UPDATE OF record_id, message_id ON public.reply_type_picks FOR EACH ROW WHEN (((old.record_id IS DISTINCT FROM new.record_id) OR (old.message_id IS DISTINCT FROM new.message_id))) EXECUTE FUNCTION public.reply_type_picks_validate_message();--> statement-breakpoint

CREATE TRIGGER reply_type_picks_reply_types_ins_trg BEFORE INSERT ON public.reply_type_picks FOR EACH ROW EXECUTE FUNCTION public.reply_type_picks_validate_reply_types();--> statement-breakpoint

CREATE TRIGGER reply_type_picks_reply_types_upd_trg BEFORE UPDATE OF record_id, previous_reply_type_id, previous_group_key, proposed_reply_type_id, proposed_group_key, applied_reply_type_id, applied_group_key ON public.reply_type_picks FOR EACH ROW WHEN (((old.record_id IS DISTINCT FROM new.record_id) OR (old.previous_reply_type_id IS DISTINCT FROM new.previous_reply_type_id) OR (old.previous_group_key IS DISTINCT FROM new.previous_group_key) OR (old.proposed_reply_type_id IS DISTINCT FROM new.proposed_reply_type_id) OR (old.proposed_group_key IS DISTINCT FROM new.proposed_group_key) OR (old.applied_reply_type_id IS DISTINCT FROM new.applied_reply_type_id) OR (old.applied_group_key IS DISTINCT FROM new.applied_group_key))) EXECUTE FUNCTION public.reply_type_picks_validate_reply_types();--> statement-breakpoint

CREATE TRIGGER reply_types_keys_trg BEFORE UPDATE OF key, group_key, reply_type_set_id, system_role ON public.reply_types FOR EACH ROW WHEN (((old.key IS DISTINCT FROM new.key) OR (old.group_key IS DISTINCT FROM new.group_key) OR (old.reply_type_set_id IS DISTINCT FROM new.reply_type_set_id) OR (old.system_role IS DISTINCT FROM new.system_role))) EXECUTE FUNCTION public.reply_types_reject_key_change();--> statement-breakpoint

CREATE TRIGGER send_attempts_account_ins_trg BEFORE INSERT ON public.send_attempts FOR EACH ROW EXECUTE FUNCTION public.send_attempts_validate_account();--> statement-breakpoint

CREATE TRIGGER send_attempts_account_upd_trg BEFORE UPDATE OF account_ref, draft_id ON public.send_attempts FOR EACH ROW WHEN (((old.account_ref IS DISTINCT FROM new.account_ref) OR (old.draft_id IS DISTINCT FROM new.draft_id))) EXECUTE FUNCTION public.send_attempts_validate_account();--> statement-breakpoint

CREATE TRIGGER send_attempts_final_status_trg BEFORE UPDATE OF status ON public.send_attempts FOR EACH ROW EXECUTE FUNCTION public.send_attempts_reject_final_status_change();--> statement-breakpoint

CREATE TRIGGER sends_final_status_trg BEFORE UPDATE OF status ON public.sends FOR EACH ROW EXECUTE FUNCTION public.sends_reject_final_status_change();--> statement-breakpoint

CREATE TRIGGER sends_unsettled_no_delete_trg BEFORE DELETE ON public.sends FOR EACH ROW WHEN ((old.status = ANY (ARRAY['sending'::text, 'unknown'::text]))) EXECUTE FUNCTION public.sends_reject_unsettled_delete();--> statement-breakpoint

CREATE TRIGGER sequence_steps_frozen_trg BEFORE INSERT OR DELETE OR UPDATE ON public.sequence_steps FOR EACH ROW EXECUTE FUNCTION public.sequence_steps_reject_published_change();--> statement-breakpoint

CREATE TRIGGER sequence_versions_frozen_trg BEFORE UPDATE OF organization_id, sequence_id, version, status, published_at ON public.sequence_versions FOR EACH ROW WHEN (((old.organization_id IS DISTINCT FROM new.organization_id) OR (old.sequence_id IS DISTINCT FROM new.sequence_id) OR (old.version IS DISTINCT FROM new.version) OR (old.status IS DISTINCT FROM new.status) OR (old.published_at IS DISTINCT FROM new.published_at))) EXECUTE FUNCTION public.sequence_versions_reject_change();--> statement-breakpoint

CREATE TRIGGER sequence_versions_no_delete_trg BEFORE DELETE ON public.sequence_versions FOR EACH ROW WHEN ((old.status = 'published'::text)) EXECUTE FUNCTION public.sequence_versions_reject_delete();
