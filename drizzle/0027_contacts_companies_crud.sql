-- Contacts and Companies CRUD ("Contacts and Companies CRUD" in docs/decisions.md). Additive except one relaxed CHECK.
--
--   * companies.crm_listed_at: when the company entered the CRM (Add company, a merge into it, or a use case that moved its last
--     contact away). Companies lists a company with this set or with a contact. No trigger writes it. The backfill sets it to the
--     earliest conversion time of each company that has a contact today; a company with only leads stays null.
--   * companies.version: the optimistic lock every company write bumps, so a merge or delete preview sees a change. Starts at 0.
--   * people.creation_key: the idempotency key of the Add contact request that created the person, 8 to 200 characters
--     (MAX_IDEMPOTENCY_KEY), unique per organization when set.
--   * company_domain_aliases: other domains of a company, written by a merge. A deleted company takes its aliases with it.
--     A domain is a company domain or an alias in one organization, never both. Every writer of a domain takes the domain lock
--     `leads-company-domain:{org}:{domain}` (or `leads-import:{org}`) first; two guard triggers back it up and raise 23505 with
--     the constraint names company_domain_is_alias and alias_is_company_domain, which the person form answers as try_again. A
--     BEFORE INSERT trigger fires once, before an ON CONFLICT wait, so the triggers alone cannot stop a merge and an upsert from
--     crossing; the domain lock does.
--   * identity_exceptions_resolution_ck: a resolved row needs resolved_at and may have a null resolved_person_id. The FK sets
--     resolved_person_id null when the person goes, and the old CHECK turned every person delete with such a row into 23514.
--   * Seven indexes on the foreign keys the contact delete deletes through (SET NULL and CASCADE from a deleted message, RESTRICT
--     checks of a deleted message or conversation). None existed, so each check scanned its table.
--
-- Drizzle cannot express the trigger functions, so they exist in this file only, like 0012, 0016, 0024 and 0025. The schema
-- declares the columns, CHECKs, the table, its keys and every index, so drizzle-kit generate prints "No schema changes".
--
-- Locks: the column adds on companies and people take ACCESS EXCLUSIVE until commit (the migrator runs all pending migrations in
-- one transaction). The partial unique index on people.creation_key scans people once. The seven foreign key indexes take SHARE on
-- records, drafts, lead_ccs, sequence_runs and sequence_step_runs, which holds off inbound ingest, drafting and follow-ups until
-- commit; CREATE INDEX CONCURRENTLY cannot run in a transaction. They use IF NOT EXISTS, as 0019 and 0021 do, so a large database
-- can build them first with CREATE INDEX CONCURRENTLY and the same names. Size the window on a copy before release, as for 0025,
-- and run it in a quiet hour.
--
-- Rollback: roll forward only.

-- Columns.
ALTER TABLE "companies" ADD COLUMN "crm_listed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "people" ADD COLUMN "creation_key" text;--> statement-breakpoint

-- New CHECKs and the relaxed resolution CHECK, each NOT VALID and then validated.
ALTER TABLE "companies" ADD CONSTRAINT "companies_version_ck" CHECK ("companies"."version" >= 0) NOT VALID;--> statement-breakpoint
ALTER TABLE "people" ADD CONSTRAINT "people_creation_key_ck" CHECK ("people"."creation_key" is null or char_length("people"."creation_key") between 8 and 200) NOT VALID;--> statement-breakpoint
ALTER TABLE "identity_exceptions" DROP CONSTRAINT "identity_exceptions_resolution_ck";--> statement-breakpoint
ALTER TABLE "identity_exceptions" ADD CONSTRAINT "identity_exceptions_resolution_ck" CHECK (("identity_exceptions"."status" = 'open' and "identity_exceptions"."resolved_person_id" is null and "identity_exceptions"."resolved_at" is null)
        or ("identity_exceptions"."status" = 'resolved' and "identity_exceptions"."resolved_at" is not null)
        or ("identity_exceptions"."status" = 'ignored' and "identity_exceptions"."resolved_person_id" is null and "identity_exceptions"."resolved_at" is not null)) NOT VALID;--> statement-breakpoint
ALTER TABLE "companies" VALIDATE CONSTRAINT "companies_version_ck";--> statement-breakpoint
ALTER TABLE "people" VALIDATE CONSTRAINT "people_creation_key_ck";--> statement-breakpoint
ALTER TABLE "identity_exceptions" VALIDATE CONSTRAINT "identity_exceptions_resolution_ck";--> statement-breakpoint

-- company_domain_aliases.
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
ALTER TABLE "company_domain_aliases" ADD CONSTRAINT "company_domain_aliases_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_domain_aliases" ADD CONSTRAINT "company_domain_aliases_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_domain_aliases" ADD CONSTRAINT "company_domain_aliases_company_fk" FOREIGN KEY ("company_id","organization_id") REFERENCES "public"."companies"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

-- Indexes: the alias table, the Add contact replay key, and the seven foreign keys of the contact delete.
CREATE INDEX "company_domain_aliases_org_company_idx" ON "company_domain_aliases" USING btree ("organization_id","company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "people_creation_key_uq" ON "people" USING btree ("organization_id","creation_key") WHERE "people"."creation_key" is not null;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "records_latest_inbound_message_idx" ON "records" USING btree ("latest_inbound_message_id") WHERE "records"."latest_inbound_message_id" is not null;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "drafts_reply_for_message_idx" ON "drafts" USING btree ("reply_for_message_id") WHERE "drafts"."reply_for_message_id" is not null;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "drafts_conversation_idx" ON "drafts" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "lead_ccs_source_message_idx" ON "lead_ccs" USING btree ("source_message_id") WHERE "lead_ccs"."source_message_id" is not null;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sequence_runs_trigger_message_idx" ON "sequence_runs" USING btree ("trigger_message_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sequence_runs_conversation_idx" ON "sequence_runs" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sequence_step_runs_sent_message_idx" ON "sequence_step_runs" USING btree ("sent_message_id") WHERE "sequence_step_runs"."sent_message_id" is not null;--> statement-breakpoint

-- Backfill: a company with a contact today is listed from its earliest conversion. version stays 0.
UPDATE "companies" AS c SET "crm_listed_at" = listed.converted_at
FROM (
	SELECT p."organization_id", p."company_id", min(p."converted_at") AS converted_at
	FROM "people" p
	WHERE p."lifecycle" = 'contact' AND p."company_id" IS NOT NULL
	GROUP BY p."organization_id", p."company_id"
) AS listed
WHERE c."id" = listed.company_id AND c."organization_id" = listed.organization_id;--> statement-breakpoint

-- Guard triggers, last. A company domain is never an alias of the same organization, and the other way round.
CREATE FUNCTION "companies_reject_alias_domain"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF EXISTS (SELECT 1 FROM company_domain_aliases a WHERE a.organization_id = NEW.organization_id AND a.domain = NEW.domain) THEN
		RAISE EXCEPTION 'companies.domain % is another domain of a company in this organization', NEW.domain
			USING ERRCODE = 'unique_violation', CONSTRAINT = 'company_domain_is_alias', TABLE = 'companies', COLUMN = 'domain';
	END IF;
	RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "companies_domain_not_alias_trg" BEFORE INSERT OR UPDATE OF "domain" ON "companies"
	FOR EACH ROW EXECUTE FUNCTION "companies_reject_alias_domain"();--> statement-breakpoint
CREATE FUNCTION "company_aliases_reject_company_domain"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF EXISTS (SELECT 1 FROM companies c WHERE c.organization_id = NEW.organization_id AND c.domain = NEW.domain) THEN
		RAISE EXCEPTION 'company_domain_aliases.domain % is the domain of a company in this organization', NEW.domain
			USING ERRCODE = 'unique_violation', CONSTRAINT = 'alias_is_company_domain', TABLE = 'company_domain_aliases', COLUMN = 'domain';
	END IF;
	RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "company_aliases_not_domain_trg" BEFORE INSERT OR UPDATE OF "domain" ON "company_domain_aliases"
	FOR EACH ROW EXECUTE FUNCTION "company_aliases_reject_company_domain"();
