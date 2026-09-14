CREATE TABLE evidence_ingestion_receipts (
 owner_scope_id uuid NOT NULL REFERENCES owner_scopes(id),
 idempotency_key text NOT NULL CHECK(idempotency_key ~ '^[a-zA-Z0-9_-]{16,128}$'),
 source_item_id uuid NOT NULL,
 PRIMARY KEY(owner_scope_id,idempotency_key),
 FOREIGN KEY(owner_scope_id,source_item_id) REFERENCES source_items(owner_scope_id,id)
);
ALTER TABLE evidence_ingestion_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE evidence_ingestion_receipts FORCE ROW LEVEL SECURITY;
CREATE POLICY receipt_read ON evidence_ingestion_receipts FOR SELECT TO unai_app
 USING(unai_private.has_owner_access(owner_scope_id) AND EXISTS(SELECT 1 FROM source_items s WHERE s.owner_scope_id=evidence_ingestion_receipts.owner_scope_id AND s.id=source_item_id));
CREATE POLICY receipt_append ON evidence_ingestion_receipts FOR INSERT TO unai_app
 WITH CHECK(unai_private.has_owner_access(owner_scope_id) AND current_setting('unai.purpose',true)='evidence.ingest'
 AND EXISTS(SELECT 1 FROM source_items s WHERE s.owner_scope_id=evidence_ingestion_receipts.owner_scope_id AND s.id=source_item_id));
GRANT SELECT,INSERT ON evidence_ingestion_receipts TO unai_app;
INSERT INTO evidence_ingestion_receipts(owner_scope_id,idempotency_key,source_item_id)
 SELECT owner_scope_id,idempotency_key,id FROM source_items;
