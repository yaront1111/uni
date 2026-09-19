-- ADR 0036. Values stay in their canonical/source rows. This journal contains
-- only mutable lifecycle and structural bindings; it cannot resurrect erased
-- source text. Existing rows start at this migration's checkpoint, not at an
-- invented historical creation state.
CREATE TABLE memory_object_state_history (
 sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 owner_scope_id uuid NOT NULL REFERENCES owner_scopes(id),
 object_type text NOT NULL CHECK(object_type IN ('entities','frame_instances','belief_slots','propositions','claims',
   'owner_overlay_deltas','resolution_assertions','memory_links','memory_threads','context_spaces')),
 object_id uuid NOT NULL,
 recorded_at timestamptz NOT NULL,
 state jsonb NOT NULL CHECK(jsonb_typeof(state)='object'),
 record_kind text NOT NULL CHECK(record_kind IN ('INITIAL','CHANGE','LEGACY_CHECKPOINT'))
);
CREATE INDEX memory_object_state_history_at ON memory_object_state_history(owner_scope_id,object_type,object_id,recorded_at DESC,sequence DESC);
ALTER TABLE memory_object_state_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory_object_state_history FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_read ON memory_object_state_history FOR SELECT TO unai_app
 USING(unai_private.has_owner_access(owner_scope_id) AND unai_private.memory_purpose(ARRAY[
 'memory.canonicalize','memory.govern','memory.inspect','memory.correct','memory.project','memory.read','memory.thread','projection.read']));
GRANT SELECT ON memory_object_state_history TO unai_app;

CREATE FUNCTION unai_private.memory_object_state(kind text, object_row jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('lifecycle',object_row->'lifecycle') || CASE kind
  WHEN 'claims' THEN jsonb_build_object('proposition_id',object_row->'proposition_id')
  WHEN 'belief_slots' THEN jsonb_build_object('context_space_id',object_row->'context_space_id')
  WHEN 'owner_overlay_deltas' THEN jsonb_build_object(
   'attached_frame_instance_id',object_row->'attached_frame_instance_id',
   'attached_belief_slot_id',object_row->'attached_belief_slot_id',
   'resolved_by_transaction_id',object_row->'resolved_by_transaction_id')
  ELSE '{}'::jsonb END
$$;
REVOKE ALL ON FUNCTION unai_private.memory_object_state(text,jsonb) FROM PUBLIC;

CREATE FUNCTION unai_private.capture_memory_object_state() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE next_state jsonb; instant timestamptz; last_instant timestamptz;
BEGIN
 IF TG_OP='DELETE' THEN
  DELETE FROM public.memory_object_state_history
   WHERE owner_scope_id=OLD.owner_scope_id AND object_type=TG_TABLE_NAME AND object_id=OLD.id;
  RETURN OLD;
 END IF;
 next_state := unai_private.memory_object_state(TG_TABLE_NAME,to_jsonb(NEW));
 IF TG_OP='UPDATE' AND next_state=unai_private.memory_object_state(TG_TABLE_NAME,to_jsonb(OLD)) THEN RETURN NEW; END IF;
 IF TG_OP='INSERT' THEN
  instant := coalesce((to_jsonb(NEW)->>'recorded_at')::timestamptz,(to_jsonb(NEW)->>'created_at')::timestamptz,clock_timestamp());
 ELSE
  SELECT max(recorded_at) INTO last_instant FROM public.memory_object_state_history
   WHERE owner_scope_id=NEW.owner_scope_id AND object_type=TG_TABLE_NAME AND object_id=NEW.id;
  -- Row locks serialize updates; using wall time here also prevents an older
  -- transaction, which waited on that lock, from backdating the next transition.
  instant := greatest(clock_timestamp(),last_instant);
 END IF;
 INSERT INTO public.memory_object_state_history(owner_scope_id,object_type,object_id,recorded_at,state,record_kind)
  VALUES(NEW.owner_scope_id,TG_TABLE_NAME,NEW.id,instant,next_state,CASE WHEN TG_OP='INSERT' THEN 'INITIAL' ELSE 'CHANGE' END);
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION unai_private.capture_memory_object_state() FROM PUBLIC;

DO $$ DECLARE relation text; BEGIN
 FOREACH relation IN ARRAY ARRAY['entities','frame_instances','belief_slots','propositions','claims','owner_overlay_deltas',
  'resolution_assertions','memory_links','memory_threads','context_spaces'] LOOP
  EXECUTE format('INSERT INTO public.memory_object_state_history(owner_scope_id,object_type,object_id,recorded_at,state,record_kind)
   SELECT owner_scope_id,%L,id,clock_timestamp(),unai_private.memory_object_state(%L,to_jsonb(o)),%L FROM public.%I o',
   relation,relation,'LEGACY_CHECKPOINT',relation);
  EXECUTE format('CREATE TRIGGER record_temporal_state AFTER INSERT OR UPDATE OR DELETE ON public.%I
   FOR EACH ROW EXECUTE FUNCTION unai_private.capture_memory_object_state()',relation);
 END LOOP;
END $$;

CREATE FUNCTION unai_private.object_state_at(owner uuid,kind text,object uuid,knowledge_time timestamptz) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT CASE WHEN unai_private.has_owner_access(owner) AND unai_private.memory_purpose(ARRAY[
  'memory.canonicalize','memory.govern','memory.inspect','memory.correct','memory.project','memory.read','memory.thread','projection.read'])
 THEN (SELECT h.state FROM public.memory_object_state_history h
  WHERE h.owner_scope_id=owner AND h.object_type=kind AND h.object_id=object AND h.recorded_at<=knowledge_time
  ORDER BY h.recorded_at DESC,h.sequence DESC LIMIT 1) ELSE NULL END
$$;
REVOKE ALL ON FUNCTION unai_private.object_state_at(uuid,text,uuid,timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION unai_private.object_state_at(uuid,text,uuid,timestamptz) TO unai_app;

-- A recorder may test present removal authority without reading the owner's
-- private control text. This boolean widens no raw overlay read permission.
CREATE FUNCTION unai_private.any_memory_object_removed(owner uuid,objects uuid[]) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT CASE WHEN unai_private.has_owner_access(owner)
  AND current_setting('unai.purpose',true) IN ('memory.read','memory.inspect','answer.record') THEN
  EXISTS(SELECT 1 FROM public.owner_overlay_deltas d WHERE d.owner_scope_id=owner
   AND d.delta_kind IN ('SUPPRESSION','DELETION') AND d.lifecycle NOT IN ('WITHDRAWN','REJECTED_AS_INTERPRETATION')
   AND d.target_object_id=ANY(objects)) ELSE true END
$$;
REVOKE ALL ON FUNCTION unai_private.any_memory_object_removed(uuid,uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION unai_private.any_memory_object_removed(uuid,uuid[]) TO unai_app;

-- Older packet schemas did not carry outcome citations. Reconstruct only the
-- permission check, never their values, for all stored outcomes before replay.
CREATE FUNCTION unai_private.stored_outcomes_readable(owner uuid,outcomes uuid[]) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT CASE WHEN unai_private.has_owner_access(owner)
  AND current_setting('unai.purpose',true) IN ('memory.read','memory.inspect','answer.record') THEN
  NOT EXISTS(SELECT 1 FROM unnest(outcomes) AS wanted(id)
   LEFT JOIN public.resolution_assertions r ON r.owner_scope_id=owner AND r.id=wanted.id
   LEFT JOIN public.claims c ON c.owner_scope_id=owner AND c.id=r.claim_id
   LEFT JOIN public.source_anchors a ON a.owner_scope_id=owner AND a.id=c.source_anchor_id
   LEFT JOIN public.source_items s ON s.owner_scope_id=owner AND s.id=a.source_item_id
   WHERE r.id IS NULL OR s.id IS NULL OR s.deleted_at IS NOT NULL
    OR unai_private.evidence_access(s.allowed_purposes,s.sensitivity) IS NOT TRUE
    OR unai_private.any_memory_object_removed(owner,ARRAY[r.id,r.claim_id,r.source_frame_instance_id,r.target_frame_instance_id,s.id]))
  ELSE false END
$$;
REVOKE ALL ON FUNCTION unai_private.stored_outcomes_readable(uuid,uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION unai_private.stored_outcomes_readable(uuid,uuid[]) TO unai_app;
