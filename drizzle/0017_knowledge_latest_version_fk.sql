-- T8b-knowledge-fk (left out of 0012): knowledge_documents.latest_version must
-- point at an existing row of knowledge_document_versions. The key is (id, latest_version) -> (document_id, version), which
-- the unique constraint knowledge_versions_doc_version_uq already backs.
--
-- DEFERRABLE INITIALLY DEFERRED because the document row is written before its first version row. The application does both
-- in one transaction (drizzle-knowledge-store.ts), so the check runs at commit. A caller that inserts the two in separate
-- autocommit statements now fails: wrap them in a transaction, or insert the version first and the document in the same one.
-- NO ACTION, the only legal action for a deferrable key. A cascade delete of a document removes the version rows and the
-- document row together, so the deferred check finds nothing left to verify.
--
-- Drizzle cannot express DEFERRABLE, so the key exists only in this file, like records.latest_inbound_message_id (0012).
-- Added NOT VALID and validated in the same migration. The migrator runs all pending migrations in one transaction, so the
-- ADD CONSTRAINT lock (SHARE ROW EXCLUSIVE on both tables) lasts until commit; on a large database apply it in a maintenance window.
--
-- Pre-check: a document whose latest_version has no version row cannot be repaired by guessing. The migration stops and names
-- the count and a query that lists the rows.
DO $$
DECLARE n bigint;
BEGIN
	SELECT count(*) INTO n FROM knowledge_documents d
	WHERE NOT EXISTS (SELECT 1 FROM knowledge_document_versions v WHERE v.document_id = d.id AND v.version = d.latest_version);
	IF n > 0 THEN
		RAISE EXCEPTION 'Migration 0017 stopped: % row(s) in knowledge_documents point at a latest_version that has no row in knowledge_document_versions. List them with: SELECT d.id, d.organization_id, d.title, d.latest_version FROM knowledge_documents d WHERE NOT EXISTS (SELECT 1 FROM knowledge_document_versions v WHERE v.document_id = d.id AND v.version = d.latest_version). Add the missing version row (or lower latest_version to a version that exists), then run the migration again.', n;
	END IF;
END $$;--> statement-breakpoint
ALTER TABLE "knowledge_documents" ADD CONSTRAINT "knowledge_documents_latest_version_fk" FOREIGN KEY ("id", "latest_version") REFERENCES "public"."knowledge_document_versions"("document_id", "version") ON DELETE NO ACTION ON UPDATE NO ACTION DEFERRABLE INITIALLY DEFERRED NOT VALID;--> statement-breakpoint
ALTER TABLE "knowledge_documents" VALIDATE CONSTRAINT "knowledge_documents_latest_version_fk";
