-- Evaluation: the shadow evaluation run record, the economic and quality metrics
-- record, and the registry migration manifest snapshot (design entities
-- `shadow_evaluation_runs`, `economic_and_quality_metrics`,
-- `registry_migration_manifests`; PRD §17.7, §20.6, §22.2, §22.4, §43.5, §45).
-- ADR 0027 records the decisions below before the code.
--
-- Four rules are carried by the schema rather than by convention:
--
--  1. A shadow run changes no production state. Its only write is this record,
--     under its own purpose `evaluation.shadow`, which no other policy admits: the
--     run reads its sample in a READ ONLY transaction under `memory.inspect` and
--     records the diff afterwards (CRT-WRT-09-A).
--  2. The metrics backend reads aggregates, not rows. `ops.metrics.read` is
--     admitted by no table policy except its own record; the counts it needs come
--     from one reviewed definer function that returns numbers and nothing else,
--     so an operations screen cannot become a way to read private memory.
--  3. Both records are statements about one moment: append-only, no UPDATE or
--     DELETE grant, and a trigger that binds the privileged principal too.
--  4. A migration manifest is part of the immutable registry snapshot. It is
--     global reference data like `registry_releases` (0006): forced RLS, no policy,
--     no application privilege, published only by the migration principal. Its
--     release ids carry no foreign key for the reason ADR 0015 §2 records, and
--     because a key into `registry_releases` would make the snapshot's own
--     truncation guard unreachable.

CREATE FUNCTION unai_private.evaluation_record_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 RAISE EXCEPTION 'EVALUATION_RECORD_IMMUTABLE' USING ERRCODE='55000';
END $$;
REVOKE ALL ON FUNCTION unai_private.evaluation_record_immutable() FROM PUBLIC;

-- One shadow evaluation run (PRD §22.2 Shadow, §43.5). The seven diffs are the
-- report `uai registry shadow-diff` computed; they hold object ids, stable codes
-- and counts only, never a value from the sample.
CREATE TABLE shadow_evaluation_runs (
 id uuid PRIMARY KEY,
 owner_scope_id uuid NOT NULL REFERENCES owner_scopes(id),
 run_kind text NOT NULL CHECK(run_kind IN ('REGISTRY','EXTRACTOR')),
 sample_ref jsonb NOT NULL CHECK(jsonb_typeof(sample_ref)='object'),
 baseline_version text NOT NULL CHECK(baseline_version ~ '^[a-z0-9][a-z0-9_.:@/-]{0,127}$'),
 candidate_version text NOT NULL CHECK(candidate_version ~ '^[a-z0-9][a-z0-9_.:@/-]{0,127}$'),
 -- PRD §22.4: extractor, registry release, belief engine and reducer versions.
 evaluation_versions jsonb NOT NULL CHECK(jsonb_typeof(evaluation_versions)='object'),
 instance_match_diff jsonb NOT NULL CHECK(jsonb_typeof(instance_match_diff)='object'),
 slot_collision_diff jsonb NOT NULL CHECK(jsonb_typeof(slot_collision_diff)='object'),
 proposition_diff jsonb NOT NULL CHECK(jsonb_typeof(proposition_diff)='object'),
 belief_status_diff jsonb NOT NULL CHECK(jsonb_typeof(belief_status_diff)='object'),
 resolution_diff jsonb NOT NULL CHECK(jsonb_typeof(resolution_diff)='object'),
 projection_diff jsonb NOT NULL CHECK(jsonb_typeof(projection_diff)='object'),
 cost_and_latency_diff jsonb NOT NULL CHECK(jsonb_typeof(cost_and_latency_diff)='object'),
 -- The computed comparison of the production digest before and after the run.
 production_unchanged boolean,
 requested_by_actor_id uuid NOT NULL,
 correlation_id uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(owner_scope_id,id)
);
CREATE INDEX shadow_evaluation_runs_owner ON shadow_evaluation_runs(owner_scope_id,created_at DESC);

ALTER TABLE shadow_evaluation_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE shadow_evaluation_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_read ON shadow_evaluation_runs FOR SELECT TO unai_app
 USING(unai_private.has_owner_access(owner_scope_id)
  AND current_setting('unai.purpose',true) IN ('evaluation.shadow','ops.shadow.read'));
CREATE POLICY owner_append ON shadow_evaluation_runs FOR INSERT TO unai_app
 WITH CHECK(unai_private.has_owner_access(owner_scope_id)
  AND current_setting('unai.purpose',true)='evaluation.shadow'
  AND requested_by_actor_id=unai_private.actor_id());
GRANT SELECT,INSERT ON shadow_evaluation_runs TO unai_app;
CREATE TRIGGER shadow_evaluation_runs_immutable BEFORE UPDATE OR DELETE ON shadow_evaluation_runs
 FOR EACH ROW EXECUTE FUNCTION unai_private.evaluation_record_immutable();

-- One measured value over one window (PRD §20.6, §45). The key list is the
-- design entity's closed vocabulary; a key whose inputs no delivered component
-- records yet is reported by the API as not measured, never written here.
CREATE TABLE economic_and_quality_metrics (
 id uuid PRIMARY KEY,
 owner_scope_id uuid NOT NULL REFERENCES owner_scopes(id),
 metric_key text NOT NULL CHECK(metric_key IN ('cost_per_source_item','cost_per_canonical_claim','cost_per_accepted_belief',
  'cost_per_belief_later_retrieved','extracted_claims_never_used','tier_routing_distribution','user_confirmation_rate',
  'user_correction_rate','false_instance_merge_rate','entity_false_merge_rate','entity_false_split_rate',
  'overlay_visibility_success','projection_rebuild_equivalence','false_certainty_incidents',
  'unsupported_personal_claim_rate','clarification_prompts_per_active_day','repeated_question_violation_rate')),
 unit text NOT NULL CHECK(unit IN ('MICROUNITS_PER_ITEM','RATIO','COUNT','PER_DAY')),
 -- Exact decimal; NULL when the denominator was zero, so an undefined rate is
 -- never recorded as a zero rate.
 value numeric(30,6),
 numerator bigint CHECK(numerator IS NULL OR numerator >= 0),
 denominator bigint CHECK(denominator IS NULL OR denominator >= 0),
 distribution jsonb CHECK(distribution IS NULL OR jsonb_typeof(distribution)='object'),
 window_start timestamptz NOT NULL,
 window_end timestamptz NOT NULL,
 metrics_version text NOT NULL CHECK(metrics_version ~ '^[a-z0-9][a-z0-9_.:@/-]{0,127}$'),
 recorded_at timestamptz NOT NULL DEFAULT now(),
 correlation_id uuid NOT NULL,
 UNIQUE(owner_scope_id,id),
 CONSTRAINT economic_and_quality_metrics_window CHECK(window_start < window_end)
);
CREATE INDEX economic_and_quality_metrics_owner ON economic_and_quality_metrics(owner_scope_id,metric_key,recorded_at DESC);

ALTER TABLE economic_and_quality_metrics ENABLE ROW LEVEL SECURITY;
ALTER TABLE economic_and_quality_metrics FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_read ON economic_and_quality_metrics FOR SELECT TO unai_app
 USING(unai_private.has_owner_access(owner_scope_id) AND current_setting('unai.purpose',true)='ops.metrics.read');
CREATE POLICY owner_append ON economic_and_quality_metrics FOR INSERT TO unai_app
 WITH CHECK(unai_private.has_owner_access(owner_scope_id) AND current_setting('unai.purpose',true)='ops.metrics.read');
GRANT SELECT,INSERT ON economic_and_quality_metrics TO unai_app;
CREATE TRIGGER economic_and_quality_metrics_immutable BEFORE UPDATE OR DELETE ON economic_and_quality_metrics
 FOR EACH ROW EXECUTE FUNCTION unai_private.evaluation_record_immutable();

-- The migration manifest of an identity-, transition-affecting or breaking
-- registry release (PRD §17.7), materialized by `uai registry publish` from the
-- `migration.yaml` inside the release's immutable Git tag.
CREATE TABLE registry_migration_manifests (
 id uuid PRIMARY KEY,
 from_registry_release_id uuid NOT NULL,
 to_registry_release_id uuid NOT NULL UNIQUE,
 from_semantic_version text NOT NULL CHECK(from_semantic_version ~ '^(0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,3})$'),
 to_semantic_version text NOT NULL UNIQUE CHECK(to_semantic_version ~ '^(0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,3})$'),
 change_class text NOT NULL CHECK(change_class IN ('ADDITIVE','COMPATIBLE_BEHAVIORAL','IDENTITY_AFFECTING','TRANSITION_AFFECTING','BREAKING')),
 slot_and_proposition_diff jsonb NOT NULL CHECK(jsonb_typeof(slot_and_proposition_diff)='object'),
 projection_replay_ref text CHECK(projection_replay_ref IS NULL OR length(projection_replay_ref) BETWEEN 1 AND 256),
 shadow_run_id uuid,
 rollback_plan text CHECK(rollback_plan IS NULL OR length(rollback_plan) BETWEEN 1 AND 8000),
 manifest_content_hash text NOT NULL CHECK(manifest_content_hash ~ '^[a-f0-9]{64}$'),
 published_by text NOT NULL DEFAULT current_user,
 correlation_id uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT registry_migration_manifests_distinct CHECK(from_registry_release_id <> to_registry_release_id)
);
CREATE TRIGGER registry_migration_manifests_immutable BEFORE UPDATE OR DELETE ON registry_migration_manifests
 FOR EACH ROW EXECUTE FUNCTION unai_private.immutable_registry_snapshot();
CREATE TRIGGER registry_migration_manifests_no_truncate BEFORE TRUNCATE ON registry_migration_manifests
 FOR EACH STATEMENT EXECUTE FUNCTION unai_private.immutable_registry_snapshot();
ALTER TABLE registry_migration_manifests ENABLE ROW LEVEL SECURITY;
ALTER TABLE registry_migration_manifests FORCE ROW LEVEL SECURITY;
REVOKE ALL ON registry_migration_manifests FROM PUBLIC, unai_app;

-- The metrics backend's only read of owner memory: counts over one window, for
-- the calling owner, under `ops.metrics.read` and nothing else. It returns NULL
-- for any other purpose or a non-member. Definer rights let it count rows the
-- purpose may not read; it returns no identifier, text or value from them.
CREATE FUNCTION unai_private.economic_and_quality_inputs(window_start timestamptz, window_end timestamptz) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 WITH scope AS (
  SELECT unai_private.owner_id() AS owner
  WHERE current_setting('unai.purpose',true)='ops.metrics.read'
   AND unai_private.has_owner_access(unai_private.owner_id())
   AND window_start < window_end
 ),
 packet_beliefs AS (
  SELECT e AS belief FROM scope s JOIN public.context_packets p ON p.owner_scope_id=s.owner,
   jsonb_array_elements(coalesce(p.packet->'currentBeliefs','[]'::jsonb) || coalesce(p.packet->'historicalBeliefs','[]'::jsonb)) e
 ),
 retrieved AS (
  SELECT b.id FROM scope s JOIN public.answer_manifests m ON m.owner_scope_id=s.owner, unnest(m.belief_ids) b(id)
  UNION
  SELECT (belief->>'propositionId')::uuid FROM packet_beliefs WHERE belief ? 'propositionId'
 ),
 used_claims AS (
  SELECT c.id FROM scope s JOIN public.answer_manifests m ON m.owner_scope_id=s.owner, unnest(m.claim_ids) c(id)
  UNION
  SELECT (x #>> '{}')::uuid FROM packet_beliefs, jsonb_array_elements(coalesce(belief->'claimIds','[]'::jsonb)) x
 ),
 accepted AS (
  SELECT DISTINCT a.proposition_id FROM scope s JOIN public.belief_assessments a ON a.owner_scope_id=s.owner
  WHERE a.assessment_status='ACCEPTED' AND a.recorded_at>=window_start AND a.recorded_at<window_end
 ),
 extracted AS (
  SELECT c.id,c.proposition_id FROM scope s JOIN public.claims c ON c.owner_scope_id=s.owner
  WHERE c.extraction_run_id IS NOT NULL AND c.recorded_at>=window_start AND c.recorded_at<window_end
 ),
 frame_merges AS (
  SELECT l.to_frame_instance_id AS survivor,l.created_at FROM scope s JOIN public.frame_instance_lineage l ON l.owner_scope_id=s.owner
  WHERE l.lineage_kind='MERGED_INTO' AND l.created_at>=window_start AND l.created_at<window_end
 ),
 entity_merges AS (
  SELECT l.to_entity_id AS survivor,l.created_at FROM scope s JOIN public.entity_lineage l ON l.owner_scope_id=s.owner
  WHERE l.lineage_kind='MERGED_INTO' AND l.created_at>=window_start AND l.created_at<window_end
 )
 SELECT jsonb_build_object(
  'sourceItems',(SELECT count(*) FROM public.source_items i WHERE i.owner_scope_id=s.owner
    AND i.observed_at>=window_start AND i.observed_at<window_end),
  'modelCalls',(SELECT count(*) FROM public.model_call_records m WHERE m.owner_scope_id=s.owner
    AND m.created_at>=window_start AND m.created_at<window_end),
  'modelCostMicrounits',(SELECT coalesce(sum(m.cost_microunits),0) FROM public.model_call_records m WHERE m.owner_scope_id=s.owner
    AND m.created_at>=window_start AND m.created_at<window_end),
  'canonicalClaims',(SELECT count(*) FROM public.claims c WHERE c.owner_scope_id=s.owner AND c.proposition_id IS NOT NULL
    AND c.recorded_at>=window_start AND c.recorded_at<window_end),
  'acceptedBeliefs',(SELECT count(*) FROM accepted),
  'acceptedBeliefsRetrieved',(SELECT count(*) FROM accepted a WHERE a.proposition_id IN (SELECT id FROM retrieved WHERE id IS NOT NULL)),
  'extractedClaims',(SELECT count(*) FROM extracted),
  'extractedClaimsNeverUsed',(SELECT count(*) FROM extracted e
    WHERE e.id NOT IN (SELECT id FROM used_claims WHERE id IS NOT NULL)
     AND (e.proposition_id IS NULL OR e.proposition_id NOT IN (SELECT id FROM retrieved WHERE id IS NOT NULL))),
  'tierRoutes',(SELECT coalesce(jsonb_object_agg(r.route,r.n),'{}'::jsonb) FROM (
    SELECT t.tier1_route AS route,count(*) AS n FROM public.triage_decisions t WHERE t.owner_scope_id=s.owner
     AND t.decided_at>=window_start AND t.decided_at<window_end GROUP BY t.tier1_route) r),
  'operations',(SELECT coalesce(jsonb_object_agg(k.kind,k.n),'{}'::jsonb) FROM (
    SELECT o.operation_kind AS kind,count(*) AS n FROM public.memory_operations o WHERE o.owner_scope_id=s.owner
     AND o.created_at>=window_start AND o.created_at<window_end GROUP BY o.operation_kind) k),
  'frameMerges',(SELECT count(*) FROM frame_merges),
  'frameMergesSplitLater',(SELECT count(*) FROM frame_merges f WHERE EXISTS(SELECT 1 FROM public.frame_instance_lineage l
    WHERE l.owner_scope_id=s.owner AND l.from_frame_instance_id=f.survivor AND l.lineage_kind='SPLIT_INTO' AND l.created_at>=f.created_at)),
  'entitiesCreated',(SELECT count(*) FROM public.entities e WHERE e.owner_scope_id=s.owner
    AND e.created_at>=window_start AND e.created_at<window_end),
  'entityMerges',(SELECT count(*) FROM entity_merges),
  'entityMergesSplitLater',(SELECT count(*) FROM entity_merges f WHERE EXISTS(SELECT 1 FROM public.entity_lineage l
    WHERE l.owner_scope_id=s.owner AND l.from_entity_id=f.survivor AND l.lineage_kind='SPLIT_INTO' AND l.created_at>=f.created_at)),
  'rebuildsCompared',(SELECT count(*) FROM public.projection_rebuild_receipts r WHERE r.owner_scope_id=s.owner
    AND r.equals_incremental IS NOT NULL AND r.created_at>=window_start AND r.created_at<window_end),
  'rebuildsEqual',(SELECT count(*) FROM public.projection_rebuild_receipts r WHERE r.owner_scope_id=s.owner
    AND r.equals_incremental AND r.created_at>=window_start AND r.created_at<window_end))
 FROM scope s
$$;
REVOKE ALL ON FUNCTION unai_private.economic_and_quality_inputs(timestamptz,timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION unai_private.economic_and_quality_inputs(timestamptz,timestamptz) TO unai_app;
