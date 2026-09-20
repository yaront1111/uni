-- Owner application transcripts, distinct from evidence and canonical memory.
CREATE TABLE conversations (
 id uuid PRIMARY KEY,
 owner_scope_id uuid NOT NULL REFERENCES owner_scopes(id),
 title text NOT NULL CHECK(length(btrim(title)) BETWEEN 1 AND 200),
 created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
 last_activity_at timestamptz NOT NULL DEFAULT statement_timestamp(),
 next_turn_order integer NOT NULL DEFAULT 0 CHECK(next_turn_order>=0),
 UNIQUE(owner_scope_id,id), CHECK(last_activity_at>=created_at)
);
CREATE INDEX conversations_activity ON conversations(owner_scope_id,last_activity_at DESC,id DESC);
ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversations FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_read ON conversations FOR SELECT TO unai_app USING(unai_private.has_owner_access(owner_scope_id)
 AND current_setting('unai.purpose',true) IN ('conversation.read','conversation.write','data.export','data.delete'));
CREATE POLICY owner_insert ON conversations FOR INSERT TO unai_app WITH CHECK(unai_private.has_owner_access(owner_scope_id)
 AND current_setting('unai.purpose',true)='conversation.write');
CREATE POLICY owner_update ON conversations FOR UPDATE TO unai_app USING(unai_private.has_owner_access(owner_scope_id)
 AND current_setting('unai.purpose',true) IN ('conversation.write','data.delete'))
 WITH CHECK(unai_private.has_owner_access(owner_scope_id));
GRANT SELECT,INSERT ON conversations TO unai_app;
GRANT UPDATE(title,last_activity_at,next_turn_order) ON conversations TO unai_app;

CREATE TABLE conversation_turns (
 id uuid PRIMARY KEY,
 owner_scope_id uuid NOT NULL REFERENCES owner_scopes(id),
 conversation_id uuid NOT NULL,
 stored_order integer NOT NULL CHECK(stored_order>=0),
 speaker text NOT NULL CHECK(speaker IN ('owner','assistant')),
 text text CHECK(length(btrim(text)) BETWEEN 1 AND 20000),
 status text NOT NULL CHECK(status IN ('pending','accepted','unable','refused','failed')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(owner_scope_id,id), UNIQUE(owner_scope_id,conversation_id,stored_order),
 FOREIGN KEY(owner_scope_id,conversation_id) REFERENCES conversations(owner_scope_id,id) ON DELETE CASCADE,
 CHECK((status='accepted' AND text IS NOT NULL) OR (status<>'accepted' AND text IS NULL)),
 CHECK(speaker<>'owner' OR status='accepted')
);
ALTER TABLE conversation_turns ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversation_turns FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_read ON conversation_turns FOR SELECT TO unai_app USING(unai_private.has_owner_access(owner_scope_id)
 AND current_setting('unai.purpose',true) IN ('conversation.read','conversation.write','data.export','data.delete'));
CREATE POLICY owner_insert ON conversation_turns FOR INSERT TO unai_app WITH CHECK(unai_private.has_owner_access(owner_scope_id)
 AND current_setting('unai.purpose',true)='conversation.write');
CREATE POLICY owner_update ON conversation_turns FOR UPDATE TO unai_app USING(unai_private.has_owner_access(owner_scope_id)
 AND current_setting('unai.purpose',true)='conversation.write') WITH CHECK(unai_private.has_owner_access(owner_scope_id));
GRANT SELECT,INSERT ON conversation_turns TO unai_app;
GRANT UPDATE(text,status) ON conversation_turns TO unai_app;

-- No application DELETE grant. This bounded eraser verifies membership itself,
-- locks the parent against append/update and records an atomic content-free audit.
CREATE FUNCTION unai_private.erase_conversation(owner uuid, conversation uuid, turn uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE n integer; removed_conversations integer := 0; audit_objects jsonb;
BEGIN
 IF unai_private.has_owner_access(owner) IS DISTINCT FROM true
 OR current_setting('unai.purpose',true) IS DISTINCT FROM 'data.delete' THEN
  RAISE EXCEPTION 'CONVERSATION_ERASURE_NOT_AUTHORIZED' USING ERRCODE='42501';
 END IF;
 PERFORM 1 FROM public.conversations WHERE owner_scope_id=owner AND id=conversation FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'CONVERSATION_NOT_FOUND' USING ERRCODE='P0002'; END IF;
 DELETE FROM public.conversation_turns WHERE owner_scope_id=owner AND conversation_id=conversation AND (turn IS NULL OR id=turn);
 GET DIAGNOSTICS n=ROW_COUNT;
 IF turn IS NOT NULL AND n=0 THEN RAISE EXCEPTION 'CONVERSATION_TURN_NOT_FOUND' USING ERRCODE='P0002'; END IF;
 IF turn IS NULL THEN
  DELETE FROM public.conversations WHERE owner_scope_id=owner AND id=conversation;
  removed_conversations := 1;
 ELSE
  UPDATE public.conversations SET last_activity_at=greatest(last_activity_at,clock_timestamp()) WHERE owner_scope_id=owner AND id=conversation;
 END IF;
 audit_objects := jsonb_build_array(jsonb_build_object('type','conversations','id',conversation,'fields',jsonb_build_array('id')));
 IF turn IS NOT NULL THEN
  audit_objects := audit_objects || jsonb_build_array(jsonb_build_object('type','conversation_turns','id',turn,'fields',jsonb_build_array('id')));
 END IF;
 INSERT INTO public.audit_events(owner_scope_id,actor,purpose,event_kind,objects_and_fields_accessed,policy_decision,model_or_code_version,result,correlation_id)
 VALUES(owner,unai_private.actor_id(),'data.delete','DELETION',audit_objects,'ALLOW','conversation-1','SUCCESS',current_setting('unai.correlation_id',true)::uuid);
 RETURN jsonb_build_object('conversationId',conversation,'turnId',turn,'conversations',removed_conversations,'conversationTurns',n);
END $$;
REVOKE ALL ON FUNCTION unai_private.erase_conversation(uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION unai_private.erase_conversation(uuid,uuid,uuid) TO unai_app;
