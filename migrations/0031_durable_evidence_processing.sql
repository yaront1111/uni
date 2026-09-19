-- ADR 0038: transactional evidence intent and resumable processing stages.
CREATE TABLE evidence_processing (
 id uuid PRIMARY KEY,
 owner_scope_id uuid NOT NULL REFERENCES owner_scopes(id),
 source_item_id uuid NOT NULL,
 actor_id uuid NOT NULL,
 data_purpose text NOT NULL CHECK(data_purpose ~ '^[A-Z][A-Z0-9_]{0,63}$'),
 maximum_sensitivity text NOT NULL CHECK(maximum_sensitivity IN ('NORMAL','PRIVATE','RESTRICTED')),
 reference_instant timestamptz,
 time_zone text CHECK(length(time_zone) BETWEEN 1 AND 64),
 source_time_precision text NOT NULL DEFAULT 'UNKNOWN' CHECK(source_time_precision IN ('EXACT_INSTANT','UNKNOWN')),
 run_kind text NOT NULL DEFAULT 'FULL' CHECK(run_kind IN ('FULL','TARGETED')),
 status text NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','EXTRACTED','CANONICALIZED','GOVERNED','SUCCEEDED','NEEDS_REVIEW')),
 registry_release_id uuid,
 job_id uuid,
 extraction_run_id uuid,
 canonicalized jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(canonicalized)='array'),
 unresolved_claims integer NOT NULL DEFAULT 0 CHECK(unresolved_claims>=0),
 transaction_id uuid,
 last_error text CHECK(last_error ~ '^[A-Z][A-Z0-9_]{0,63}$'),
 created_at timestamptz NOT NULL DEFAULT now(),
 completed_at timestamptz,
 UNIQUE(owner_scope_id,id), UNIQUE(owner_scope_id,source_item_id),
 FOREIGN KEY(owner_scope_id,source_item_id) REFERENCES source_items(owner_scope_id,id),
 FOREIGN KEY(owner_scope_id,actor_id) REFERENCES owner_scope_members(owner_scope_id,user_id),
 FOREIGN KEY(owner_scope_id,job_id) REFERENCES jobs(owner_scope_id,id),
 CHECK((reference_instant IS NULL)=(source_time_precision='UNKNOWN'))
);
CREATE INDEX evidence_processing_pending ON evidence_processing(owner_scope_id,status,created_at);
ALTER TABLE evidence_processing ENABLE ROW LEVEL SECURITY;
ALTER TABLE evidence_processing FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_read ON evidence_processing FOR SELECT TO unai_app USING (
 unai_private.has_owner_access(owner_scope_id) AND (
 current_setting('unai.purpose',true)=ANY(ARRAY['jobs.enqueue','jobs.work','memory.project']) OR
 EXISTS(SELECT 1 FROM source_items s WHERE s.owner_scope_id=evidence_processing.owner_scope_id AND s.id=source_item_id)));
CREATE POLICY owner_append ON evidence_processing FOR INSERT TO unai_app WITH CHECK (
 unai_private.has_owner_access(owner_scope_id) AND actor_id=unai_private.actor_id()
 AND current_setting('unai.purpose',true)=ANY(ARRAY['evidence.ingest','connector.sync'])
 AND EXISTS(SELECT 1 FROM source_items s WHERE s.owner_scope_id=evidence_processing.owner_scope_id AND s.id=source_item_id));
CREATE POLICY owner_drive ON evidence_processing FOR UPDATE TO unai_app USING (
 unai_private.has_owner_access(owner_scope_id)
 AND current_setting('unai.purpose',true)=ANY(ARRAY['jobs.enqueue','memory.extract','memory.canonicalize','memory.govern','memory.project']))
 WITH CHECK(unai_private.has_owner_access(owner_scope_id));
GRANT SELECT,INSERT,UPDATE ON evidence_processing TO unai_app;

CREATE FUNCTION unai_private.record_processing_intent() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF NEW.tier1_route NOT IN ('FULL_EXTRACTION','ENTITY_EXTRACTION')
  OR coalesce(current_setting('unai.purpose',true),'') NOT IN ('evidence.ingest','connector.sync') THEN RETURN NEW; END IF;
 INSERT INTO public.evidence_processing(id,owner_scope_id,source_item_id,actor_id,data_purpose,maximum_sensitivity,
  reference_instant,time_zone,source_time_precision)
 SELECT s.id,s.owner_scope_id,s.id,unai_private.actor_id(),current_setting('unai.data_purpose',true),
  current_setting('unai.maximum_sensitivity',true),s.occurred_at,
  CASE WHEN length(s.deterministic_metadata->>'timeZone') BETWEEN 1 AND 64 THEN s.deterministic_metadata->>'timeZone' END,
  CASE WHEN s.occurred_at IS NULL THEN 'UNKNOWN' ELSE 'EXACT_INSTANT' END
 FROM public.source_items s WHERE s.owner_scope_id=NEW.owner_scope_id AND s.id=NEW.source_item_id
  AND s.actor_ref->>'type'<>'ASSISTANT' AND s.source_type<>'DOCUMENT'
 ON CONFLICT(owner_scope_id,source_item_id) DO NOTHING;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION unai_private.record_processing_intent() FROM PUBLIC;
CREATE TRIGGER triage_processing_intent AFTER INSERT ON triage_decisions
 FOR EACH ROW EXECUTE FUNCTION unai_private.record_processing_intent();

-- Recover eligible evidence left unprocessed by deployments without a worker.
-- Owner corrections and other already canonicalized sources retain their own path.
INSERT INTO evidence_processing(id,owner_scope_id,source_item_id,actor_id,data_purpose,maximum_sensitivity,
 reference_instant,time_zone,source_time_precision)
SELECT s.id,s.owner_scope_id,s.id,s.submitted_by_user_id,s.allowed_purposes[1],s.sensitivity,s.occurred_at,
 CASE WHEN length(s.deterministic_metadata->>'timeZone') BETWEEN 1 AND 64 THEN s.deterministic_metadata->>'timeZone' END,
 CASE WHEN s.occurred_at IS NULL THEN 'UNKNOWN' ELSE 'EXACT_INSTANT' END
FROM source_items s JOIN triage_decisions t ON t.owner_scope_id=s.owner_scope_id AND t.source_item_id=s.id
WHERE t.tier1_route IN ('FULL_EXTRACTION','ENTITY_EXTRACTION') AND s.deleted_at IS NULL
 AND s.actor_ref->>'type'<>'ASSISTANT' AND s.source_type<>'DOCUMENT'
 AND NOT(s.deterministic_metadata ?| ARRAY['memoryOperationKind','deltaKind','clarificationCardId'])
 AND NOT EXISTS(SELECT 1 FROM source_anchors a JOIN claims c ON c.owner_scope_id=a.owner_scope_id AND c.source_anchor_id=a.id
  WHERE a.owner_scope_id=s.owner_scope_id AND a.source_item_id=s.id AND c.proposition_id IS NOT NULL)
ON CONFLICT(owner_scope_id,source_item_id) DO NOTHING;

-- Existing document jobs are explicit extraction requests made before this
-- ledger existed. Keep their immutable payload and queue identity, but recover
-- source time from evidence, never the old upload-time/UTC fallback. Deferred
-- documents require TARGETED even though the legacy producer always wrote FULL.
INSERT INTO evidence_processing(id,owner_scope_id,source_item_id,actor_id,data_purpose,maximum_sensitivity,
 reference_instant,time_zone,source_time_precision,run_kind,registry_release_id,job_id)
SELECT DISTINCT ON (s.owner_scope_id,s.id)
 s.id,s.owner_scope_id,s.id,s.submitted_by_user_id,j.payload->>'dataPurpose',j.payload->>'maximumSensitivity',s.occurred_at,
 CASE WHEN length(s.deterministic_metadata->>'timeZone') BETWEEN 1 AND 64 THEN s.deterministic_metadata->>'timeZone' END,
 CASE WHEN s.occurred_at IS NULL THEN 'UNKNOWN' ELSE 'EXACT_INSTANT' END,
 CASE WHEN t.tier1_route='DEFER_UNTIL_RELEVANT' THEN 'TARGETED' ELSE coalesce(j.payload->>'runKind','FULL') END,
 (j.payload->>'registryReleaseId')::uuid,j.id
FROM source_items s JOIN triage_decisions t ON t.owner_scope_id=s.owner_scope_id AND t.source_item_id=s.id
JOIN jobs j ON j.owner_scope_id=s.owner_scope_id AND j.job_kind='evidence.extract' AND j.payload->>'sourceItemId'=s.id::text
WHERE s.source_type='DOCUMENT' AND s.deleted_at IS NULL AND s.actor_ref->>'type'<>'ASSISTANT'
 AND t.tier1_route IN ('FULL_EXTRACTION','ENTITY_EXTRACTION','DEFER_UNTIL_RELEVANT')
 AND j.status IN ('PENDING','RUNNING','FAILED','DEAD_LETTER') AND j.payload->>'ownerScopeId'=s.owner_scope_id::text
 AND coalesce(j.payload->>'runKind','FULL') IN ('FULL','TARGETED')
 AND j.payload->>'dataPurpose' ~ '^[A-Z][A-Z0-9_]{0,63}$'
 AND j.payload->>'maximumSensitivity' IN ('NORMAL','PRIVATE','RESTRICTED')
 AND j.payload->>'registryReleaseId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
ORDER BY s.owner_scope_id,s.id,j.created_at,j.id
ON CONFLICT(owner_scope_id,source_item_id) DO NOTHING;

ALTER TABLE extraction_runs ADD COLUMN processing_key text CHECK(length(processing_key) BETWEEN 16 AND 128);
ALTER TABLE extraction_runs ADD COLUMN unknown_count integer NOT NULL DEFAULT 0 CHECK(unknown_count>=0);
GRANT UPDATE(unknown_count) ON extraction_runs TO unai_app;
CREATE UNIQUE INDEX extraction_successful_processing_key ON extraction_runs(owner_scope_id,processing_key)
 WHERE processing_key IS NOT NULL AND status='SUCCEEDED';

-- One immutable release label for startup validation, never its contract body.
CREATE FUNCTION unai_private.processing_release_version(release_id uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT r.semantic_version FROM public.registry_releases r WHERE r.id=release_id AND r.lifecycle='RELEASED'
  AND unai_private.has_owner_access(unai_private.owner_id())
  AND current_setting('unai.purpose',true)='memory.govern'
$$;
REVOKE ALL ON FUNCTION unai_private.processing_release_version(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION unai_private.processing_release_version(uuid) TO unai_app;
