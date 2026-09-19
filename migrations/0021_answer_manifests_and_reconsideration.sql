-- Answer provenance: the manifest of what each answer's model was supplied, the
-- assistant conversation evidence every answer is stored as, and the derived
-- reconsideration candidates (design entities `answer_manifests` and
-- `reconsideration_candidates`; PRD §21.7, §23.6, §23.7, §24; ADR 0026 records
-- the decisions below before the code).
--
-- Four rules are carried by the schema rather than by convention:
--
--  1. Recording an answer is its own purpose. `answer.record` is never a request
--     purpose: the Ask route opens it for one transaction after the answer is
--     validated. It may insert an ASSISTANT-authored ASSISTANT_CONVERSATION source
--     item (with its object key, receipt, anchor and triage row), read the packet
--     it records, and insert the manifest -- nothing canonical. `memory.read`
--     stays a read (ADR 0022 §1).
--  2. A manifest is a statement about one moment. It is immutable, no DELETE is
--     granted, and it references the persisted packet it was derived from.
--  3. Reconsideration is derived by the database. A materially changed belief or
--     a moved overlay delta records one candidate row per earlier manifest that
--     contained it, whichever writer made the change (CRT-RD-11-A).
--  4. Old answers are preserved: nothing here rewrites a manifest, a packet or the
--     conversation evidence (PRD §23.7).

-- The recording purpose reads and writes evidence, so it joins the purposes the
-- evidence gate admits; the data purpose and the sensitivity ceiling still decide.
-- `connector.sync` is migration 0018's, which replaced this function before it;
-- replacing it again must never narrow what an earlier migration admitted.
CREATE OR REPLACE FUNCTION unai_private.evidence_access(purposes text[], sensitivity text) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT current_setting('unai.purpose',true) IN ('evidence.ingest','evidence.read','connector.read','connector.sync','memory.extract','memory.canonicalize','memory.govern','memory.correct','memory.read','memory.inspect','answer.record')
 AND current_setting('unai.data_purpose',true)=ANY(purposes)
 AND array_position(ARRAY['NORMAL','PRIVATE','RESTRICTED'],sensitivity)
 <= array_position(ARRAY['NORMAL','PRIVATE','RESTRICTED'],current_setting('unai.maximum_sensitivity',true))
$$;

-- CRT-AI-01-A: the recording purpose may create exactly one kind of evidence, an
-- assistant's conversation message. It can never write an owner statement or a
-- connector item. Each policy is added beside the delivered ones, which keep
-- every condition they had; none of them widens what may be read.
CREATE POLICY evidence_append_answer ON source_items FOR INSERT TO unai_app
 WITH CHECK(unai_private.has_owner_access(owner_scope_id) AND submitted_by_user_id=unai_private.actor_id()
 AND current_setting('unai.purpose',true)='answer.record' AND connector_id IS NULL
 AND source_type='ASSISTANT_CONVERSATION' AND actor_ref->>'type'='ASSISTANT'
 AND unai_private.evidence_access(allowed_purposes,sensitivity));
CREATE POLICY receipt_append_answer ON evidence_ingestion_receipts FOR INSERT TO unai_app
 WITH CHECK(unai_private.has_owner_access(owner_scope_id)
 AND current_setting('unai.purpose',true)='answer.record'
 AND EXISTS(SELECT 1 FROM source_items s WHERE s.owner_scope_id=evidence_ingestion_receipts.owner_scope_id AND s.id=source_item_id
  AND s.source_type='ASSISTANT_CONVERSATION'));
CREATE POLICY object_key_append_answer ON evidence_object_keys FOR INSERT TO unai_app
 WITH CHECK(unai_private.has_owner_access(owner_scope_id)
 AND current_setting('unai.purpose',true)='answer.record'
 AND EXISTS(SELECT 1 FROM source_items s WHERE s.owner_scope_id=evidence_object_keys.owner_scope_id AND s.id=source_item_id
  AND s.source_type='ASSISTANT_CONVERSATION'));
CREATE POLICY anchor_append_answer ON source_anchors FOR INSERT TO unai_app
 WITH CHECK(unai_private.has_owner_access(owner_scope_id)
 AND current_setting('unai.purpose',true)='answer.record'
 AND EXISTS(SELECT 1 FROM source_items s WHERE s.owner_scope_id=source_anchors.owner_scope_id AND s.id=source_item_id
  AND s.source_type='ASSISTANT_CONVERSATION'));
-- Every ingested item has a recorded route, an assistant's message included: the
-- route is SOURCE_ONLY, which is what keeps it out of extraction.
CREATE POLICY owner_append_answer ON triage_decisions FOR INSERT TO unai_app
 WITH CHECK(unai_private.has_owner_access(owner_scope_id)
 AND unai_private.extraction_purpose(ARRAY['answer.record'])
 AND EXISTS(SELECT 1 FROM source_items s WHERE s.owner_scope_id=triage_decisions.owner_scope_id AND s.id=source_item_id));
CREATE POLICY owner_read_answer ON triage_decisions FOR SELECT TO unai_app
 USING(unai_private.has_owner_access(owner_scope_id)
 AND unai_private.extraction_purpose(ARRAY['answer.record'])
 AND EXISTS(SELECT 1 FROM source_items s WHERE s.owner_scope_id=triage_decisions.owner_scope_id AND s.id=source_item_id));

-- The manifest is derived from the persisted packet, so the recording purpose
-- reads it back (ADR 0026 §1). It cannot write one.
CREATE POLICY owner_read_answer ON context_packets FOR SELECT TO unai_app
 USING(unai_private.has_owner_access(owner_scope_id) AND unai_private.memory_purpose(ARRAY['answer.record']));

CREATE TABLE answer_manifests (
 id uuid PRIMARY KEY,
 owner_scope_id uuid NOT NULL REFERENCES owner_scopes(id),
 context_packet_id uuid NOT NULL,
 packet_hash text NOT NULL CHECK(packet_hash ~ '^[a-f0-9]{64}$'),
 -- The assistant conversation evidence the presented answer was stored as.
 conversation_message_id uuid NOT NULL,
 requesting_actor_id uuid NOT NULL,
 model_provider text NOT NULL CHECK(model_provider ~ '^[a-z][a-z0-9_.-]{0,63}$'),
 model_id text NOT NULL CHECK(length(model_id) BETWEEN 1 AND 128),
 prompt_version text NOT NULL CHECK(prompt_version ~ '^[a-z][a-z0-9_.-]{0,63}$'),
 composer_version text NOT NULL CHECK(composer_version ~ '^[a-z][a-z0-9_.-]{0,63}$'),
 -- The context supplied to the model. These are sets of what the packet held,
 -- never a statement of which item the model used (CRT-RD-07-A).
 belief_ids uuid[] NOT NULL,
 claim_ids uuid[] NOT NULL,
 evidence_ids uuid[] NOT NULL,
 overlay_delta_ids uuid[] NOT NULL,
 projection_versions jsonb NOT NULL CHECK(jsonb_typeof(projection_versions)='object'),
 watermarks jsonb NOT NULL CHECK(jsonb_typeof(watermarks)='object'),
 registry_release text CHECK(registry_release IS NULL OR length(registry_release) BETWEEN 1 AND 32),
 registry_release_id uuid,
 grounding_validator_result jsonb NOT NULL CHECK(jsonb_typeof(grounding_validator_result)='object'
  AND grounding_validator_result ? 'action'
  AND grounding_validator_result->>'action' IN ('PASSED','DOWNGRADED','REGENERATED','BLOCKED')),
 manifest_version text NOT NULL CHECK(manifest_version ~ '^[a-z][a-z0-9_.-]{0,63}$'),
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(owner_scope_id,id),
 FOREIGN KEY(owner_scope_id,context_packet_id) REFERENCES context_packets(owner_scope_id,id),
 FOREIGN KEY(owner_scope_id,conversation_message_id) REFERENCES source_items(owner_scope_id,id),
 FOREIGN KEY(owner_scope_id,requesting_actor_id) REFERENCES owner_scope_members(owner_scope_id,user_id)
);
CREATE INDEX answer_manifests_owner ON answer_manifests(owner_scope_id,created_at DESC);
CREATE INDEX answer_manifests_beliefs ON answer_manifests USING gin(belief_ids);
CREATE INDEX answer_manifests_overlay_deltas ON answer_manifests USING gin(overlay_delta_ids);

ALTER TABLE answer_manifests ENABLE ROW LEVEL SECURITY;
ALTER TABLE answer_manifests FORCE ROW LEVEL SECURITY;
-- The inspector reads a manifest; the governed and canonicalization paths read
-- them to record which manifests contained a delta they contest (CRT-RYW-05-A).
CREATE POLICY owner_read ON answer_manifests FOR SELECT TO unai_app
 USING(unai_private.has_owner_access(owner_scope_id)
 AND unai_private.memory_purpose(ARRAY['memory.read','memory.inspect','memory.govern','memory.canonicalize','memory.correct','answer.record']));
CREATE POLICY owner_record ON answer_manifests FOR INSERT TO unai_app
 WITH CHECK(unai_private.has_owner_access(owner_scope_id) AND unai_private.memory_purpose(ARRAY['answer.record'])
 AND requesting_actor_id=unai_private.actor_id());
GRANT SELECT,INSERT ON answer_manifests TO unai_app;
CREATE TRIGGER answer_manifests_immutable BEFORE UPDATE ON answer_manifests
 FOR EACH ROW EXECUTE FUNCTION unai_private.canonicalization_record_immutable();

CREATE TABLE reconsideration_candidates (
 id uuid PRIMARY KEY,
 owner_scope_id uuid NOT NULL REFERENCES owner_scopes(id),
 changed_object_type text NOT NULL CHECK(changed_object_type IN ('proposition','owner_overlay_delta')),
 changed_object_id uuid NOT NULL,
 answer_manifest_id uuid NOT NULL,
 change_kind text NOT NULL CHECK(change_kind IN ('BELIEF_ASSESSMENT_CHANGED','CLAIM_CORRECTED','CLAIM_SUPERSEDED',
  'CLAIM_RETRACTED','CLAIM_CONTRADICTED','OVERLAY_DELTA_LIFECYCLE_CHANGED')),
 -- The row whose arrival was the change: an assessment version, a claim relation,
 -- or (for a delta) a fresh id per lifecycle move.
 change_ref uuid NOT NULL,
 detail jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(detail)='object'),
 detected_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(owner_scope_id,id),
 UNIQUE(owner_scope_id,answer_manifest_id,changed_object_type,changed_object_id,change_ref),
 FOREIGN KEY(owner_scope_id,answer_manifest_id) REFERENCES answer_manifests(owner_scope_id,id)
);
CREATE INDEX reconsideration_candidates_object ON reconsideration_candidates(owner_scope_id,changed_object_type,changed_object_id);

ALTER TABLE reconsideration_candidates ENABLE ROW LEVEL SECURITY;
ALTER TABLE reconsideration_candidates FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_read ON reconsideration_candidates FOR SELECT TO unai_app
 USING(unai_private.has_owner_access(owner_scope_id)
 AND unai_private.memory_purpose(ARRAY['memory.read','memory.inspect','memory.govern','answer.record']));
-- No INSERT policy and no INSERT grant: the only writer is the derivation below.
GRANT SELECT ON reconsideration_candidates TO unai_app;
CREATE TRIGGER reconsideration_candidates_immutable BEFORE UPDATE ON reconsideration_candidates
 FOR EACH ROW EXECUTE FUNCTION unai_private.canonicalization_record_immutable();

-- One candidate row per earlier manifest that contained the changed object. It is
-- SECURITY DEFINER because the change arrives under whatever purpose its writer
-- holds (governor, bitemporal change, correction) and none of them may insert
-- here; the body filters by the changed row's own owner scope and writes nothing
-- but this derived table. The writer audits the change itself.
CREATE OR REPLACE FUNCTION unai_private.record_reconsideration(owner uuid, object_type text, object_id uuid,
 kind text, ref uuid, detail jsonb) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
 INSERT INTO public.reconsideration_candidates(id,owner_scope_id,changed_object_type,changed_object_id,
  answer_manifest_id,change_kind,change_ref,detail)
 SELECT gen_random_uuid(),m.owner_scope_id,object_type,object_id,m.id,kind,ref,detail
 FROM public.answer_manifests m
 WHERE m.owner_scope_id=owner AND m.created_at<=now()
  AND ((object_type='proposition' AND m.belief_ids @> ARRAY[object_id])
   OR (object_type='owner_overlay_delta' AND m.overlay_delta_ids @> ARRAY[object_id]))
 ON CONFLICT DO NOTHING
$$;
REVOKE ALL ON FUNCTION unai_private.record_reconsideration(uuid,text,uuid,text,uuid,jsonb) FROM PUBLIC;

-- A new assessment version is a material change when its status or its valid
-- interval differs from the version it closes, or when it is the first.
CREATE OR REPLACE FUNCTION unai_private.assessment_reconsideration() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE
 previous_status text; previous_from timestamptz; previous_to timestamptz; had_previous boolean;
BEGIN
 SELECT assessment_status,valid_from,valid_to INTO previous_status,previous_from,previous_to
 FROM public.belief_assessments
 WHERE owner_scope_id=NEW.owner_scope_id AND proposition_id=NEW.proposition_id AND id<>NEW.id
 ORDER BY recorded_at DESC,id DESC LIMIT 1;
 had_previous:=FOUND;
 IF NOT had_previous OR previous_status IS DISTINCT FROM NEW.assessment_status
  OR previous_from IS DISTINCT FROM NEW.valid_from OR previous_to IS DISTINCT FROM NEW.valid_to THEN
  PERFORM unai_private.record_reconsideration(NEW.owner_scope_id,'proposition',NEW.proposition_id,
   'BELIEF_ASSESSMENT_CHANGED',NEW.id,
   jsonb_build_object('fromStatus',previous_status,'toStatus',NEW.assessment_status));
 END IF;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION unai_private.assessment_reconsideration() FROM PUBLIC;
CREATE OR REPLACE TRIGGER belief_assessments_reconsideration AFTER INSERT ON belief_assessments
 FOR EACH ROW EXECUTE FUNCTION unai_private.assessment_reconsideration();

-- A correction, supersession, retraction or contradiction of one of a
-- proposition's claims changes what that belief can be said to be.
CREATE OR REPLACE FUNCTION unai_private.claim_relation_reconsideration() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE target uuid;
BEGIN
 SELECT proposition_id INTO target FROM public.claims WHERE owner_scope_id=NEW.owner_scope_id AND id=NEW.to_claim_id;
 IF target IS NOT NULL THEN
  PERFORM unai_private.record_reconsideration(NEW.owner_scope_id,'proposition',target,
   CASE NEW.relation_kind WHEN 'CORRECTS' THEN 'CLAIM_CORRECTED' WHEN 'SUPERSEDES' THEN 'CLAIM_SUPERSEDED'
    WHEN 'RETRACTS' THEN 'CLAIM_RETRACTED' ELSE 'CLAIM_CONTRADICTED' END,
   NEW.id,jsonb_build_object('relationKind',NEW.relation_kind,'claimId',NEW.to_claim_id));
 END IF;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION unai_private.claim_relation_reconsideration() FROM PUBLIC;
CREATE OR REPLACE TRIGGER claim_relations_reconsideration AFTER INSERT ON claim_relations
 FOR EACH ROW WHEN (NEW.relation_kind IN ('CORRECTS','SUPERSEDES','RETRACTS','CONTRADICTS'))
 EXECUTE FUNCTION unai_private.claim_relation_reconsideration();

-- A pending delta that moves -- committed, contested, withdrawn -- changes what an
-- answer that included it said about the owner's own word.
CREATE OR REPLACE FUNCTION unai_private.overlay_reconsideration() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 PERFORM unai_private.record_reconsideration(NEW.owner_scope_id,'owner_overlay_delta',NEW.id,
  'OVERLAY_DELTA_LIFECYCLE_CHANGED',gen_random_uuid(),
  jsonb_build_object('fromLifecycle',OLD.lifecycle,'toLifecycle',NEW.lifecycle));
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION unai_private.overlay_reconsideration() FROM PUBLIC;
CREATE OR REPLACE TRIGGER owner_overlay_deltas_reconsideration AFTER UPDATE OF lifecycle ON owner_overlay_deltas
 FOR EACH ROW WHEN (OLD.lifecycle IS DISTINCT FROM NEW.lifecycle)
 EXECUTE FUNCTION unai_private.overlay_reconsideration();
