-- people.company_id gets the tenant-composite foreign key every other child table already has (audit finding 9).
--
--   * Before: people.company_id -> companies (id) only. A person could point at a company of another organization.
--   * After: people (company_id, organization_id) -> companies (id, organization_id) ON DELETE SET NULL (company_id), so
--     organization_id stays set when a company is deleted. companies_id_org_uq is the target and exists since 0001.
--   * Existing rows: a company_id whose company is missing or belongs to another organization is set to null, with a NOTICE
--     that names the count. Nothing else changes.
--   * The key is added NOT VALID, validated, and then replaces people_company_id_companies_id_fk.
--
-- Locks: ADD CONSTRAINT takes SHARE ROW EXCLUSIVE on people and companies until commit (the migrator runs all pending
-- migrations in one transaction). On a large people table, run it in a maintenance window. The UPDATE touches only rows
-- that already break the rule.
DO $$
DECLARE
	n bigint;
BEGIN
	UPDATE "people" p SET "company_id" = NULL
	WHERE p."company_id" IS NOT NULL
	  AND NOT EXISTS (SELECT 1 FROM "companies" c WHERE c."id" = p."company_id" AND c."organization_id" = p."organization_id");
	GET DIAGNOSTICS n = ROW_COUNT;
	IF n > 0 THEN
		RAISE NOTICE 'Migration 0024: set people.company_id to null on % row(s) whose company is missing or belongs to another organization.', n;
	END IF;
END $$;--> statement-breakpoint
ALTER TABLE "people" ADD CONSTRAINT "people_company_fk" FOREIGN KEY ("company_id", "organization_id") REFERENCES "companies" ("id", "organization_id") ON DELETE SET NULL ("company_id") NOT VALID;--> statement-breakpoint
ALTER TABLE "people" VALIDATE CONSTRAINT "people_company_fk";--> statement-breakpoint
ALTER TABLE "people" DROP CONSTRAINT "people_company_id_companies_id_fk";
