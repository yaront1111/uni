-- Canonicalization and bitemporal state: the frame-instance match record and the
-- claim relation that tells a correction from a change (design entities
-- `instance_match_candidates` and `claim_relations`; PRD §13.4, §33.5, §33.6,
-- §57). The bitemporal query modes of PRD §12.3 need no table of their own: valid
-- time lives on `belief_assessments.valid_from`/`valid_to` and recorded time on
-- `recorded_at`/`superseded_recorded_at`, both delivered by migration 0012, and
-- this file adds the indexes those three query modes read through.
--
-- Two rules are carried by the schema rather than by convention:
--
--  1. Only `CONFIRMED_MATCH` may reuse an existing frame instance for a material
--     accepted update (PRD §13.4). `instance_match_reuse_confirmed` makes a
--     PROBABLE_MATCH or POSSIBLE_MATCH reuse unrepresentable, so the under-merge
--     default survives a bug in the matcher (CRT-MEM-11-C).
--  2. A correction and a change are different rows, not one row with different
--     text (PRD §57). `CORRECTS` may only carry `SAME_VALID_INTERVAL` and
--     `SUPERSEDES` only `NEW_VALID_PERIOD`, so the two cases cannot collapse into
--     one representation (CRT-MEM-09-A).

-- What the matcher considered, what it decided and why (PRD §13.4). One row per
-- candidate examined, plus one row for the decision that examined none, so the
-- Memory inspector can show the instances an extraction did *not* join.
--
-- extraction_run_id is nullable: matching normally runs over extractor output,
-- but an owner who states an instance resolution in the correction workflow has
-- no run, and a null there is honest where a fabricated run id would not be.
CREATE TABLE instance_match_candidates (
 id uuid PRIMARY KEY,
 owner_scope_id uuid NOT NULL REFERENCES owner_scopes(id),
 extraction_run_id uuid,
 claim_id uuid,
 frame_type_id text NOT NULL CHECK(frame_type_id ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
 candidate_frame_instance_id uuid,
 resolved_frame_instance_id uuid,
 match_outcome text NOT NULL CHECK(match_outcome IN ('CONFIRMED_MATCH','PROBABLE_MATCH','POSSIBLE_MATCH','CONFIRMED_DISTINCT','NEW_INSTANCE')),
 materiality text NOT NULL CHECK(materiality IN ('MATERIAL_ACCEPTED_UPDATE','NON_MATERIAL')),
 reused_existing_instance boolean NOT NULL DEFAULT false,
 score numeric CHECK(score >= 0 AND score <= 1),
 score_components jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(score_components)='object'),
 decision_reason jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(decision_reason)='object'),
 matcher_version text NOT NULL CHECK(matcher_version ~ '^[a-z][a-z0-9_.-]{0,63}$'),
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(owner_scope_id,id),
 FOREIGN KEY(owner_scope_id,extraction_run_id) REFERENCES extraction_runs(owner_scope_id,id),
 FOREIGN KEY(owner_scope_id,claim_id) REFERENCES claims(owner_scope_id,id),
 FOREIGN KEY(owner_scope_id,candidate_frame_instance_id) REFERENCES frame_instances(owner_scope_id,id),
 FOREIGN KEY(owner_scope_id,resolved_frame_instance_id) REFERENCES frame_instances(owner_scope_id,id),
 -- NEW_INSTANCE is the outcome for "nothing to compare with"; every other
 -- outcome is a statement about one candidate and must name it.
 CONSTRAINT instance_match_candidate_named CHECK((match_outcome='NEW_INSTANCE')=(candidate_frame_instance_id IS NULL)),
 CONSTRAINT instance_match_reuse_names_candidate CHECK(NOT reused_existing_instance
  OR (candidate_frame_instance_id IS NOT NULL AND resolved_frame_instance_id=candidate_frame_instance_id)),
 -- PRD §13.4 and CRT-MEM-11-C, in the schema: a material accepted update reuses
 -- an instance only behind a CONFIRMED_MATCH.
 CONSTRAINT instance_match_reuse_confirmed CHECK(NOT reused_existing_instance
  OR materiality<>'MATERIAL_ACCEPTED_UPDATE' OR match_outcome='CONFIRMED_MATCH')
);
CREATE INDEX instance_match_candidates_resolved ON instance_match_candidates(owner_scope_id,resolved_frame_instance_id,created_at);
CREATE INDEX instance_match_candidates_candidate ON instance_match_candidates(owner_scope_id,candidate_frame_instance_id,created_at);
CREATE INDEX instance_match_candidates_run ON instance_match_candidates(owner_scope_id,extraction_run_id);

-- How one claim stands to another (PRD §33.6). `temporal_effect` is what keeps
-- "Actually it was 55,000" apart from "it changed to 55,000 on August 1": the
-- first speaks about the interval the corrected claim already covered, the second
-- opens a period that begins where the earlier one ends.
CREATE TABLE claim_relations (
 id uuid PRIMARY KEY,
 owner_scope_id uuid NOT NULL REFERENCES owner_scopes(id),
 from_claim_id uuid NOT NULL,
 to_claim_id uuid NOT NULL,
 relation_kind text NOT NULL CHECK(relation_kind IN ('CORRECTS','SUPERSEDES','REPEATS','CONFIRMS','CONTRADICTS','CLARIFIES','RETRACTS')),
 temporal_effect text NOT NULL CHECK(temporal_effect IN ('SAME_VALID_INTERVAL','NEW_VALID_PERIOD','NO_VALID_TIME_EFFECT')),
 valid_from timestamptz,
 valid_to timestamptz,
 created_by_transaction_id uuid,
 metadata jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(metadata)='object'),
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(owner_scope_id,id),
 FOREIGN KEY(owner_scope_id,from_claim_id) REFERENCES claims(owner_scope_id,id),
 FOREIGN KEY(owner_scope_id,to_claim_id) REFERENCES claims(owner_scope_id,id),
 FOREIGN KEY(owner_scope_id,created_by_transaction_id) REFERENCES belief_transactions(owner_scope_id,id),
 CONSTRAINT claim_relations_distinct CHECK(from_claim_id <> to_claim_id),
 CONSTRAINT claim_relations_interval CHECK(valid_to IS NULL OR valid_from IS NULL OR valid_from <= valid_to),
 -- CRT-MEM-09-A in the schema: a correction cannot claim a new period and a
 -- change cannot claim the old one.
 CONSTRAINT claim_relations_correction_interval CHECK(relation_kind<>'CORRECTS' OR temporal_effect='SAME_VALID_INTERVAL'),
 CONSTRAINT claim_relations_change_interval CHECK(relation_kind<>'SUPERSEDES' OR temporal_effect='NEW_VALID_PERIOD'),
 CONSTRAINT claim_relations_period_stated CHECK(temporal_effect<>'NEW_VALID_PERIOD' OR valid_from IS NOT NULL)
);
CREATE INDEX claim_relations_from ON claim_relations(owner_scope_id,from_claim_id,relation_kind);
CREATE INDEX claim_relations_to ON claim_relations(owner_scope_id,to_claim_id,relation_kind);

-- The three query modes of PRD §12.3 read one proposition set over two time axes.
-- Valid time is answered from the assessment row, so the index leads with the
-- proposition and carries both windows.
CREATE INDEX belief_assessments_bitemporal ON belief_assessments(owner_scope_id,proposition_id,recorded_at,superseded_recorded_at);
CREATE INDEX propositions_slot_value ON propositions(owner_scope_id,belief_slot_id,id);

ALTER TABLE instance_match_candidates ENABLE ROW LEVEL SECURITY;
ALTER TABLE instance_match_candidates FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_read ON instance_match_candidates FOR SELECT TO unai_app
 USING(unai_private.has_owner_access(owner_scope_id)
 AND unai_private.memory_purpose(ARRAY['memory.canonicalize','memory.govern','memory.inspect']));
CREATE POLICY owner_append ON instance_match_candidates FOR INSERT TO unai_app
 WITH CHECK(unai_private.has_owner_access(owner_scope_id)
 AND unai_private.memory_purpose(ARRAY['memory.canonicalize','memory.govern']));
GRANT SELECT,INSERT ON instance_match_candidates TO unai_app;

ALTER TABLE claim_relations ENABLE ROW LEVEL SECURITY;
ALTER TABLE claim_relations FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_read ON claim_relations FOR SELECT TO unai_app
 USING(unai_private.has_owner_access(owner_scope_id)
 AND unai_private.memory_purpose(ARRAY['memory.canonicalize','memory.govern','memory.inspect']));
CREATE POLICY owner_append ON claim_relations FOR INSERT TO unai_app
 WITH CHECK(unai_private.has_owner_access(owner_scope_id)
 AND unai_private.memory_purpose(ARRAY['memory.canonicalize','memory.govern']));
GRANT SELECT,INSERT ON claim_relations TO unai_app;

-- Both tables are statements about a moment: what the matcher decided then, and
-- how one claim stood to another then. Neither takes an UPDATE or DELETE grant,
-- and the trigger binds the privileged migration owner too.
CREATE FUNCTION unai_private.canonicalization_record_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 RAISE EXCEPTION 'CANONICALIZATION_RECORD_IMMUTABLE' USING ERRCODE='55000';
END $$;
REVOKE ALL ON FUNCTION unai_private.canonicalization_record_immutable() FROM PUBLIC;
CREATE TRIGGER instance_match_candidates_immutable BEFORE UPDATE ON instance_match_candidates
 FOR EACH ROW EXECUTE FUNCTION unai_private.canonicalization_record_immutable();
CREATE TRIGGER claim_relations_immutable BEFORE UPDATE ON claim_relations
 FOR EACH ROW EXECUTE FUNCTION unai_private.canonicalization_record_immutable();

-- Recorded time only moves forward. Closing a live assessment version at an
-- instant before it was recorded would let a later write change what the kernel
-- answers for an earlier knowledge time, which is exactly what the historical
-- belief query of PRD §12.3 must be safe from. The `>=` check on the columns
-- themselves already exists (migration 0012); this trigger adds the ordering
-- against wall-clock time, so no row can be closed in the future either.
CREATE FUNCTION unai_private.knowledge_time_monotonic() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF NEW.superseded_recorded_at IS NOT NULL AND NEW.superseded_recorded_at > now() THEN
  RAISE EXCEPTION 'KNOWLEDGE_TIME_IN_FUTURE' USING ERRCODE='55000';
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION unai_private.knowledge_time_monotonic() FROM PUBLIC;
CREATE TRIGGER belief_assessment_knowledge_time BEFORE UPDATE ON belief_assessments
 FOR EACH ROW EXECUTE FUNCTION unai_private.knowledge_time_monotonic();

CREATE FUNCTION unai_private.recorded_time_not_future() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF NEW.recorded_at > now() THEN
  RAISE EXCEPTION 'KNOWLEDGE_TIME_IN_FUTURE' USING ERRCODE='55000';
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION unai_private.recorded_time_not_future() FROM PUBLIC;
CREATE TRIGGER belief_assessment_recorded_time BEFORE INSERT ON belief_assessments
 FOR EACH ROW EXECUTE FUNCTION unai_private.recorded_time_not_future();
