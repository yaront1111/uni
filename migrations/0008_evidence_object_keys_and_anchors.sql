-- Evidence object keys and deterministic source anchors.
--
-- The object-store location and the encryption key that protects it move out of
-- source_items into their own row. source_items.raw_object_ref is then the public
-- handle a read may return, and evidence_object_keys.object_store_key is the
-- private location a public API response must never carry: one row per source
-- item, so cryptographic deletion has exactly one target to destroy.
CREATE TABLE evidence_object_keys (
 id uuid PRIMARY KEY,
 owner_scope_id uuid NOT NULL REFERENCES owner_scopes(id),
 source_item_id uuid NOT NULL,
 object_store_key text NOT NULL UNIQUE CHECK(length(object_store_key) BETWEEN 1 AND 1024),
 encryption_key_ref text NOT NULL CHECK(length(encryption_key_ref) BETWEEN 1 AND 512),
 created_at timestamptz NOT NULL DEFAULT now(),
 deleted_at timestamptz,
 UNIQUE(owner_scope_id,source_item_id),
 FOREIGN KEY(owner_scope_id,source_item_id) REFERENCES source_items(owner_scope_id,id)
);
INSERT INTO evidence_object_keys(id,owner_scope_id,source_item_id,object_store_key,encryption_key_ref)
 SELECT gen_random_uuid(),owner_scope_id,id,raw_object_ref,'kms:unspecified' FROM source_items;
ALTER TABLE source_items DROP COLUMN raw_object_ref;
ALTER TABLE source_items RENAME COLUMN raw_object_id TO raw_object_ref;

ALTER TABLE evidence_object_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE evidence_object_keys FORCE ROW LEVEL SECURITY;
-- The evidence row's own policy decides whether this owner, purpose and sensitivity
-- ceiling may see the item at all; the key row never widens that decision.
CREATE POLICY object_key_read ON evidence_object_keys FOR SELECT TO unai_app
 USING(unai_private.has_owner_access(owner_scope_id) AND deleted_at IS NULL
 AND EXISTS(SELECT 1 FROM source_items s WHERE s.owner_scope_id=evidence_object_keys.owner_scope_id AND s.id=source_item_id));
CREATE POLICY object_key_append ON evidence_object_keys FOR INSERT TO unai_app
 WITH CHECK(unai_private.has_owner_access(owner_scope_id) AND current_setting('unai.purpose',true)='evidence.ingest'
 AND EXISTS(SELECT 1 FROM source_items s WHERE s.owner_scope_id=evidence_object_keys.owner_scope_id AND s.id=source_item_id));
GRANT SELECT,INSERT ON evidence_object_keys TO unai_app;
CREATE TRIGGER immutable_object_key BEFORE UPDATE ON evidence_object_keys FOR EACH ROW EXECUTE FUNCTION unai_private.immutable_evidence();

-- Anchors carry the closed vocabulary the deterministic parsers emit: a message
-- span, a document page range, a calendar field, a connector JSON path, or a
-- GitHub comment. Rows are immutable, so normalize any earlier kind with the
-- trigger suspended rather than leaving the constraint unenforceable.
ALTER TABLE source_anchors DISABLE TRIGGER immutable_anchor;
UPDATE source_anchors SET anchor_kind='CONNECTOR_JSON_PATH'
 WHERE anchor_kind NOT IN ('MESSAGE_SPAN','DOCUMENT_RANGE','CALENDAR_FIELD','CONNECTOR_JSON_PATH','GITHUB_COMMENT');
ALTER TABLE source_anchors ENABLE TRIGGER immutable_anchor;
ALTER TABLE source_anchors ADD CONSTRAINT source_anchors_kind
 CHECK(anchor_kind IN ('MESSAGE_SPAN','DOCUMENT_RANGE','CALENDAR_FIELD','CONNECTOR_JSON_PATH','GITHUB_COMMENT'));
-- Re-importing the same raw fixture re-derives the same anchors, so anchoring is
-- idempotent on the anchor itself rather than on a caller-supplied key.
CREATE UNIQUE INDEX source_anchors_identity ON source_anchors(owner_scope_id,source_item_id,anchor_kind,anchor);
CREATE POLICY anchor_append ON source_anchors FOR INSERT TO unai_app
 WITH CHECK(unai_private.has_owner_access(owner_scope_id) AND current_setting('unai.purpose',true)='evidence.ingest'
 AND EXISTS(SELECT 1 FROM source_items s WHERE s.owner_scope_id=source_anchors.owner_scope_id AND s.id=source_item_id));
GRANT INSERT ON source_anchors TO unai_app;
