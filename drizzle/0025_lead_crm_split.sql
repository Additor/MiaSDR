-- Lead and CRM split ("Leads and CRM" in docs/decisions.md). Additive: no existing row changes meaning.
--
--   * people.lifecycle ('lead' or 'contact', default 'lead') and people.converted_at. A person becomes a contact when a deal is
--     created from it, and never goes back. A trigger rejects contact to lead and any change of converted_at once set. A direct
--     INSERT with lifecycle 'contact' stays legal (tests, support SQL); no product path does it.
--   * deal_stages (the organization's ordered pipeline; kind open, won or lost, immutable) and deals (one opportunity with a
--     contact). A deal's stage_kind is part of its composite key to the stage, so the closed_at and lost_reason CHECKs can read it.
--     A deal's person must be a contact on insert, and person_id and organization_id never change.
--   * campaign_enrollments: two narrow triggers refuse a pending or active enrollment for a contact (message
--     contact_cannot_be_enrolled, SQLSTATE 23514). They fire on INSERT and on a move into pending or active from another status
--     (restore), and on nothing the send engine writes (pending to active after a first send, active to active, every move to a
--     final status), so markSent, applyAcceptance and the LinkedIn webhook loop never read people and cannot meet the conversion's
--     locks. The function reads the person FOR SHARE, so an enrollment that races a conversion waits for it and then fails.
--   * The five default stages (New, Meeting, Proposal open; Won; Lost) for every organization that exists now. An organization
--     created later gets them from ensureDealStages.
--
-- Existing rows: every person keeps lifecycle 'lead' with converted_at null (a constant default, no table rewrite). No row of any
-- other table changes. Organizations get stage rows.
--
-- Drizzle cannot express the DEFERRABLE position key, ON DELETE SET NULL (column), the triggers or the functions, so they exist in
-- this file only, like 0012, 0016, 0017, 0020 and 0024. deal_stages_org_position_uq is DEFERRABLE INITIALLY DEFERRED so a swap of
-- two positions works inside one transaction while a duplicate fails at commit. A deferrable key cannot be an ON CONFLICT
-- arbiter: deal_stages_org_name_uq (lower(name)) is the arbiter for the stage seed.
--
-- Locks: ALTER TABLE people ADD COLUMN takes ACCESS EXCLUSIVE until commit (the migrator runs all pending migrations in one
-- transaction), so the two people CHECKs, their validation scan and the partial index build all run under it. The window is
-- O(people) for the validation scan and the index; NOT VALID then VALIDATE gives no concurrency benefit here but leaves every
-- constraint validated, as migrations-over-data requires. The deals foreign keys lock people and campaign_enrollments (SHARE ROW
-- EXCLUSIVE); the two campaign_enrollments triggers come last because CREATE TRIGGER takes SHARE ROW EXCLUSIVE on that table and
-- blocks sends until commit. Run it in a maintenance window on a large database.
--
-- Rollback: roll forward only. Application code that predates this release fails with contact_cannot_be_enrolled when it enrolls
-- a contact; that is the intended guard.

-- people: columns, checks, trigger, partial index.
ALTER TABLE "people" ADD COLUMN "lifecycle" text DEFAULT 'lead' NOT NULL;--> statement-breakpoint
ALTER TABLE "people" ADD COLUMN "converted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "people" ADD CONSTRAINT "people_lifecycle_ck" CHECK ("people"."lifecycle" in ('lead', 'contact')) NOT VALID;--> statement-breakpoint
ALTER TABLE "people" ADD CONSTRAINT "people_converted_at_ck" CHECK (("people"."lifecycle" = 'contact') = ("people"."converted_at" is not null)) NOT VALID;--> statement-breakpoint
ALTER TABLE "people" VALIDATE CONSTRAINT "people_lifecycle_ck";--> statement-breakpoint
ALTER TABLE "people" VALIDATE CONSTRAINT "people_converted_at_ck";--> statement-breakpoint
CREATE INDEX "people_org_contacts_idx" ON "people" USING btree ("organization_id","converted_at" DESC NULLS FIRST,"id") WHERE "people"."lifecycle" = 'contact';--> statement-breakpoint
CREATE FUNCTION "people_reject_lifecycle_change"() RETURNS trigger LANGUAGE plpgsql AS $$
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
CREATE TRIGGER "people_lifecycle_trg" BEFORE UPDATE OF "lifecycle", "converted_at" ON "people"
	FOR EACH ROW WHEN (OLD."lifecycle" IS DISTINCT FROM NEW."lifecycle" OR OLD."converted_at" IS DISTINCT FROM NEW."converted_at")
	EXECUTE FUNCTION "people_reject_lifecycle_change"();--> statement-breakpoint

-- deal_stages and deals.
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
ALTER TABLE "deal_stages" ADD CONSTRAINT "deal_stages_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deals" ADD CONSTRAINT "deals_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deals" ADD CONSTRAINT "deals_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deals" ADD CONSTRAINT "deals_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deals" ADD CONSTRAINT "deals_person_fk" FOREIGN KEY ("person_id","organization_id") REFERENCES "public"."people"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deals" ADD CONSTRAINT "deals_stage_fk" FOREIGN KEY ("stage_id","organization_id","stage_kind") REFERENCES "public"."deal_stages"("id","organization_id","kind") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "deals" ADD CONSTRAINT "deals_source_enrollment_fk" FOREIGN KEY ("source_enrollment_id","organization_id") REFERENCES "public"."campaign_enrollments"("id","organization_id") ON DELETE set null ("source_enrollment_id") ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "deal_stages_org_name_uq" ON "deal_stages" USING btree ("organization_id",lower("name"));--> statement-breakpoint
CREATE UNIQUE INDEX "deals_idempotency_uq" ON "deals" USING btree ("organization_id","person_id","idempotency_key") WHERE "deals"."idempotency_key" is not null;--> statement-breakpoint
CREATE INDEX "deals_org_stage_idx" ON "deals" USING btree ("organization_id","stage_id","stage_changed_at" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "deals_org_person_idx" ON "deals" USING btree ("organization_id","person_id");--> statement-breakpoint

-- A stage's kind never changes: a deal's stage_kind copies it and the closed_at and lost_reason CHECKs read the copy.
CREATE FUNCTION "deal_stages_reject_kind_change"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	RAISE EXCEPTION 'deal_stages.kind is immutable: create a new stage instead'
		USING ERRCODE = 'integrity_constraint_violation', TABLE = 'deal_stages', COLUMN = 'kind';
END $$;--> statement-breakpoint
CREATE TRIGGER "deal_stages_kind_trg" BEFORE UPDATE OF "kind" ON "deal_stages"
	FOR EACH ROW WHEN (OLD."kind" IS DISTINCT FROM NEW."kind") EXECUTE FUNCTION "deal_stages_reject_kind_change"();--> statement-breakpoint

-- A deal belongs to a contact. A person who does not exist in the organization is left to deals_person_fk.
CREATE FUNCTION "deals_require_contact"() RETURNS trigger LANGUAGE plpgsql AS $$
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
CREATE TRIGGER "deals_contact_trg" BEFORE INSERT ON "deals"
	FOR EACH ROW EXECUTE FUNCTION "deals_require_contact"();--> statement-breakpoint
CREATE FUNCTION "deals_reject_person_change"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	RAISE EXCEPTION 'deals.person_id and deals.organization_id are immutable'
		USING ERRCODE = 'integrity_constraint_violation', TABLE = 'deals', COLUMN = 'person_id';
END $$;--> statement-breakpoint
CREATE TRIGGER "deals_person_trg" BEFORE UPDATE OF "person_id", "organization_id" ON "deals"
	FOR EACH ROW WHEN (OLD."person_id" IS DISTINCT FROM NEW."person_id" OR OLD."organization_id" IS DISTINCT FROM NEW."organization_id")
	EXECUTE FUNCTION "deals_reject_person_change"();--> statement-breakpoint

-- Default stages for every organization that exists now.
INSERT INTO "deal_stages" ("organization_id", "name", "kind", "position")
SELECT o."id", s."name", s."kind", s."position"
FROM "organizations" o
CROSS JOIN (VALUES ('New', 'open', 1), ('Meeting', 'open', 2), ('Proposal', 'open', 3), ('Won', 'won', 4), ('Lost', 'lost', 5)) AS s("name", "kind", "position");--> statement-breakpoint

-- campaign_enrollments, last. Same shape as migration 0020: an INSERT trigger and an UPDATE trigger, because OLD is not allowed
-- in the WHEN clause of an INSERT trigger. The WHEN clauses keep every other write off this function.
CREATE FUNCTION "campaign_enrollments_reject_contact"() RETURNS trigger LANGUAGE plpgsql AS $$
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
CREATE TRIGGER "campaign_enrollments_contact_ins_trg" BEFORE INSERT ON "campaign_enrollments"
	FOR EACH ROW WHEN (NEW."status" IN ('pending', 'active')) EXECUTE FUNCTION "campaign_enrollments_reject_contact"();--> statement-breakpoint
CREATE TRIGGER "campaign_enrollments_contact_upd_trg" BEFORE UPDATE OF "status" ON "campaign_enrollments"
	FOR EACH ROW WHEN (NEW."status" IN ('pending', 'active') AND OLD."status" NOT IN ('pending', 'active')) EXECUTE FUNCTION "campaign_enrollments_reject_contact"();
