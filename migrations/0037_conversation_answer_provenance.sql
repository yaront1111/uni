-- Conversation-backed answer provenance; legacy evidence manifests remain intact.
ALTER TABLE answer_manifests ALTER COLUMN conversation_message_id DROP NOT NULL;
ALTER TABLE conversation_turns ADD CONSTRAINT conversation_turn_identity UNIQUE(owner_scope_id,conversation_id,id);
ALTER TABLE conversation_turns ADD COLUMN data_purpose text;
ALTER TABLE conversation_turns ADD COLUMN sensitivity text CHECK(sensitivity IN ('NORMAL','PRIVATE','RESTRICTED'));
ALTER TABLE conversation_turns ADD CONSTRAINT conversation_turn_scope CHECK((data_purpose IS NULL)=(sensitivity IS NULL));
-- The validated answer can contain up to two hundred 2000-character statements.
ALTER TABLE conversation_turns DROP CONSTRAINT conversation_turns_text_check;
ALTER TABLE conversation_turns ADD CHECK(text IS NULL OR length(btrim(text)) BETWEEN 1 AND 400199);

CREATE TABLE answer_provenance (
 owner_scope_id uuid NOT NULL,
 answer_manifest_id uuid NOT NULL,
 conversation_id uuid NOT NULL,
 turn_id uuid NOT NULL,
 PRIMARY KEY(owner_scope_id,answer_manifest_id),
 UNIQUE(owner_scope_id,turn_id),
 FOREIGN KEY(owner_scope_id,answer_manifest_id) REFERENCES answer_manifests(owner_scope_id,id),
 FOREIGN KEY(owner_scope_id,conversation_id,turn_id) REFERENCES conversation_turns(owner_scope_id,conversation_id,id) ON DELETE CASCADE
);
ALTER TABLE answer_provenance ENABLE ROW LEVEL SECURITY;
ALTER TABLE answer_provenance FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_read ON answer_provenance FOR SELECT TO unai_app USING(unai_private.has_owner_access(owner_scope_id)
 AND current_setting('unai.purpose',true) IN ('answer.record','memory.inspect','memory.read','conversation.read','conversation.write','data.export','data.delete'));
CREATE POLICY owner_insert ON answer_provenance FOR INSERT TO unai_app WITH CHECK(unai_private.has_owner_access(owner_scope_id)
 AND current_setting('unai.purpose',true)='answer.record'
 AND EXISTS(SELECT 1 FROM conversation_turns t WHERE t.owner_scope_id=answer_provenance.owner_scope_id AND t.id=turn_id AND t.speaker='assistant')
 AND EXISTS(SELECT 1 FROM answer_manifests m WHERE m.owner_scope_id=answer_provenance.owner_scope_id AND m.id=answer_manifest_id AND m.conversation_message_id IS NULL));
GRANT SELECT,INSERT ON answer_provenance TO unai_app;

CREATE POLICY answer_read ON conversations FOR SELECT TO unai_app USING(unai_private.has_owner_access(owner_scope_id)
 AND current_setting('unai.purpose',true)='answer.record');
CREATE POLICY answer_insert ON conversations FOR INSERT TO unai_app WITH CHECK(unai_private.has_owner_access(owner_scope_id)
 AND current_setting('unai.purpose',true)='answer.record');
CREATE POLICY answer_update ON conversations FOR UPDATE TO unai_app USING(unai_private.has_owner_access(owner_scope_id)
 AND current_setting('unai.purpose',true)='answer.record') WITH CHECK(unai_private.has_owner_access(owner_scope_id));
CREATE POLICY answer_read ON conversation_turns FOR SELECT TO unai_app USING(unai_private.has_owner_access(owner_scope_id)
 AND current_setting('unai.purpose',true) IN ('answer.record','memory.inspect'));
CREATE POLICY answer_insert ON conversation_turns FOR INSERT TO unai_app WITH CHECK(unai_private.has_owner_access(owner_scope_id)
 AND current_setting('unai.purpose',true)='answer.record' AND data_purpose=current_setting('unai.data_purpose',true)
 AND sensitivity=current_setting('unai.maximum_sensitivity',true));
-- Original transcript rows retain their semantics; newly grounded rows retain
-- the request's purpose and ceiling on every read, including export.
CREATE POLICY grounded_scope ON conversation_turns AS RESTRICTIVE FOR SELECT TO unai_app USING(
 data_purpose IS NULL OR current_setting('unai.purpose',true)='data.delete' OR
 (data_purpose=current_setting('unai.data_purpose',true)
 AND array_position(ARRAY['NORMAL','PRIVATE','RESTRICTED'],sensitivity)
 <= array_position(ARRAY['NORMAL','PRIVATE','RESTRICTED'],current_setting('unai.maximum_sensitivity',true))));
CREATE POLICY grounded_immutable ON conversation_turns AS RESTRICTIVE FOR UPDATE TO unai_app
 USING(data_purpose IS NULL) WITH CHECK(data_purpose IS NULL);

-- The old evidence write authority is no longer needed by answer.record.
DROP POLICY evidence_append_answer ON source_items;
DROP POLICY receipt_append_answer ON evidence_ingestion_receipts;
DROP POLICY object_key_append_answer ON evidence_object_keys;
DROP POLICY anchor_append_answer ON source_anchors;
DROP POLICY owner_append_answer ON triage_decisions;
