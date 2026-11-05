ALTER TABLE "knowledge_documents" DROP CONSTRAINT "knowledge_documents_kind_ck";--> statement-breakpoint
-- Old kinds move to the Brain kinds. An organization keeps one active company profile, its newest; the others wait in Needs sorting and stay in prompts.
UPDATE "knowledge_documents" SET "kind" = 'unsorted' WHERE "kind" IN ('faq', 'scheduling', 'custom')--> statement-breakpoint
UPDATE "knowledge_documents" SET "kind" = 'price_book' WHERE "kind" = 'pricing'--> statement-breakpoint
UPDATE "knowledge_documents" SET "kind" = 'objection_handling' WHERE "kind" = 'objection'--> statement-breakpoint
UPDATE "knowledge_documents" d SET "kind" = 'unsorted'
FROM (
  SELECT "id", row_number() OVER (PARTITION BY "organization_id" ORDER BY "updated_at" DESC, "id") AS n
  FROM "knowledge_documents" WHERE "kind" = 'company' AND "active"
) ranked
WHERE d."id" = ranked."id" AND ranked.n > 1--> statement-breakpoint
UPDATE "knowledge_documents" SET "kind" = 'company_profile' WHERE "kind" = 'company'--> statement-breakpoint
ALTER TABLE "knowledge_documents" ADD CONSTRAINT "knowledge_documents_kind_ck" CHECK ("knowledge_documents"."kind" in ('product', 'company_profile', 'price_book', 'icp', 'competitor', 'case_study', 'testimonial', 'objection_handling', 'qualification', 'unsorted'));--> statement-breakpoint
ALTER TABLE "knowledge_document_versions" ADD COLUMN "structured_data" jsonb;--> statement-breakpoint
ALTER TABLE "knowledge_documents" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "knowledge_documents" ADD COLUMN "created_by" uuid;--> statement-breakpoint
ALTER TABLE "knowledge_documents" ADD CONSTRAINT "knowledge_documents_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "knowledge_documents_created_by_idx" ON "knowledge_documents" USING btree ("created_by") WHERE "knowledge_documents"."created_by" is not null;--> statement-breakpoint
ALTER TABLE "knowledge_documents" ADD CONSTRAINT "knowledge_documents_description_ck" CHECK ("knowledge_documents"."description" is null or length("knowledge_documents"."description") <= 1000);--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_company_profile_uq" ON "knowledge_documents" USING btree ("organization_id") WHERE "knowledge_documents"."kind" = 'company_profile' and "knowledge_documents"."active";
