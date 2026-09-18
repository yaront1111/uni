-- The model path and bounded extraction: the triage decision recorded for every
-- ingested item, the extraction run that produces span-anchored claims, and the
-- per-call model accounting the gateway writes (design entities
-- `triage_decisions`, `extraction_runs`, `model_call_records`; PRD §20, §22.1,
-- §33.2, §36.2, §36.3). ADR 0016 records the decisions below before the code.
--
-- Three invariants are carried by the schema rather than by convention:
--
--  1. A route always has a reason (PRD §20.2). `tier1_route` is the closed
--     five-value vocabulary and `routing_reason` must be an object carrying a
--     `code` and the router version that decided it. Neither is nullable, so an
--     unexplained route is unrepresentable.
--  2. A triage decision precedes deep extraction. `extraction_runs` references
--     the decision it ran under, NOT NULL, so a run cannot exist for an item
--     nothing ever routed.
--  3. A run that succeeded says what it cost. Status-conditional checks require
--     model provider, model id, prompt version, cost and latency on SUCCEEDED,
--     and an error code on FAILED (ADR 0016 §4, CRT-WRT-08-A).

-- One decision per source item, recorded in the ingest transaction itself
-- (ADR 0016 §2). Re-ingesting identical bytes re-derives the same route, so the
-- uniqueness index makes the second write a no-op rather than a second decision.
CREATE TABLE triage_decisions (
 id uuid PRIMARY KEY,
 owner_scope_id uuid NOT NULL REFERENCES owner_scopes(id),
 source_item_id uuid NOT NULL,
 tier0_parsed jsonb NOT NULL CHECK(jsonb_typeof(tier0_parsed)='object'),
 tier1_route text NOT NULL CHECK(tier1_route IN ('SOURCE_ONLY','INDEX_ONLY','ENTITY_EXTRACTION','FULL_EXTRACTION','DEFER_UNTIL_RELEVANT')),
 routing_reason jsonb NOT NULL,
 cost_budget_microunits bigint NOT NULL CHECK(cost_budget_microunits >= 0),
 decided_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(owner_scope_id,id),
 UNIQUE(owner_scope_id,source_item_id),
 FOREIGN KEY(owner_scope_id,source_item_id) REFERENCES source_items(owner_scope_id,id),
 CONSTRAINT triage_decisions_reason_recorded CHECK(
  jsonb_typeof(routing_reason)='object'
  AND routing_reason ? 'code' AND jsonb_typeof(routing_reason->'code')='string'
  AND routing_reason ? 'routerVersion' AND jsonb_typeof(routing_reason->'routerVersion')='string'),
 -- A route that spends nothing may not be recorded with a budget to spend, and a
 -- deep route may not be recorded with none: the budget bounds the model path.
 CONSTRAINT triage_decisions_budget_matches_route CHECK(
  (tier1_route IN ('ENTITY_EXTRACTION','FULL_EXTRACTION')) = (cost_budget_microunits > 0))
);
CREATE INDEX triage_decisions_route ON triage_decisions(owner_scope_id,tier1_route,decided_at);

-- One extraction attempt over one source item (PRD §36.3). Re-extraction inserts
-- a new run and new claims; nothing here updates a claim, so prior rows stay
-- byte-identical (PRD §22.1, CRT-WRT-08-A).
--
-- registry_release_id is the pinned release the run normalized under. It carries
-- no foreign key for the reason ADR 0015 §2 recorded and ADR 0016 §3 restates:
-- `registry_releases` is the global immutable snapshot of ADR 0011, and a
-- reference from owner-scoped data would preempt its own truncation guard.
CREATE TABLE extraction_runs (
 id uuid PRIMARY KEY,
 owner_scope_id uuid NOT NULL REFERENCES owner_scopes(id),
 source_item_id uuid NOT NULL,
 triage_decision_id uuid NOT NULL,
 run_kind text NOT NULL CHECK(run_kind IN ('LAZY','TARGETED','SHADOW','FULL')),
 model_provider text CHECK(model_provider ~ '^[a-z][a-z0-9_.-]{0,63}$'),
 model_id text CHECK(length(model_id) BETWEEN 1 AND 128),
 prompt_version text CHECK(prompt_version ~ '^[a-z][a-z0-9_.-]{0,63}$'),
 registry_release_id uuid NOT NULL,
 normalization_version text NOT NULL CHECK(normalization_version ~ '^[a-z][a-z0-9_.-]{0,63}$'),
 entity_resolver_version text NOT NULL CHECK(entity_resolver_version ~ '^[a-z][a-z0-9_.-]{0,63}$'),
 temporal_resolver_version text NOT NULL CHECK(temporal_resolver_version ~ '^[a-z][a-z0-9_.-]{0,63}$'),
 status text NOT NULL DEFAULT 'RUNNING' CHECK(status IN ('RUNNING','SUCCEEDED','FAILED')),
 cost_microunits bigint CHECK(cost_microunits >= 0),
 latency_ms integer CHECK(latency_ms >= 0),
 started_at timestamptz NOT NULL DEFAULT now(),
 completed_at timestamptz,
 error_code text CHECK(error_code ~ '^[A-Z][A-Z0-9_]{0,63}$'),
 UNIQUE(owner_scope_id,id),
 FOREIGN KEY(owner_scope_id,source_item_id) REFERENCES source_items(owner_scope_id,id),
 FOREIGN KEY(owner_scope_id,triage_decision_id) REFERENCES triage_decisions(owner_scope_id,id),
 CONSTRAINT extraction_runs_completion CHECK((status='RUNNING')=(completed_at IS NULL)),
 CONSTRAINT extraction_runs_completion_ordered CHECK(completed_at IS NULL OR completed_at >= started_at),
 CONSTRAINT extraction_runs_failure_explained CHECK((status='FAILED')=(error_code IS NOT NULL)),
 -- A succeeded run records the model it used and what that cost. Nothing else
 -- makes cost per source item and cost per claim recoverable afterwards.
 CONSTRAINT extraction_runs_success_accounted CHECK(status<>'SUCCEEDED' OR (
  model_provider IS NOT NULL AND model_id IS NOT NULL AND prompt_version IS NOT NULL
  AND cost_microunits IS NOT NULL AND latency_ms IS NOT NULL))
);
CREATE INDEX extraction_runs_source ON extraction_runs(owner_scope_id,source_item_id,started_at);
CREATE INDEX extraction_runs_status ON extraction_runs(owner_scope_id,status,started_at);

-- What every model call cost, for every caller of the gateway (PRD §20.6). The
-- row carries no prompt text, no provider message, no response content and no
-- credential: only model, prompt version, cost, latency, correlation id and
-- outcome (CRT-NFR-06-A). A rejected or failed call is recorded too — it spent
-- money just the same.
CREATE TABLE model_call_records (
 id uuid PRIMARY KEY,
 owner_scope_id uuid NOT NULL REFERENCES owner_scopes(id),
 purpose text NOT NULL CHECK(purpose ~ '^[a-z][a-z0-9_.:-]{0,63}$'),
 model_provider text NOT NULL CHECK(model_provider ~ '^[a-z][a-z0-9_.-]{0,63}$'),
 model_id text NOT NULL CHECK(length(model_id) BETWEEN 1 AND 128),
 prompt_version text NOT NULL CHECK(prompt_version ~ '^[a-z][a-z0-9_.-]{0,63}$'),
 extraction_run_id uuid,
 cost_microunits bigint NOT NULL CHECK(cost_microunits >= 0),
 latency_ms integer NOT NULL CHECK(latency_ms >= 0),
 correlation_id uuid NOT NULL,
 outcome text NOT NULL CHECK(outcome IN ('SUCCEEDED','OUTPUT_REJECTED','PROVIDER_FAILED')),
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(owner_scope_id,id),
 FOREIGN KEY(owner_scope_id,extraction_run_id) REFERENCES extraction_runs(owner_scope_id,id)
);
CREATE INDEX model_call_records_owner ON model_call_records(owner_scope_id,created_at);
CREATE INDEX model_call_records_run ON model_call_records(owner_scope_id,extraction_run_id);

-- Handoff from the canonical identity node (ADR 0015 §1): claims.extraction_run_id
-- was `CHECK(extraction_run_id IS NULL)` because extraction_runs did not exist.
-- The table exists now, so the placeholder gives way to the composite owner
-- foreign key. No claim row is altered: the column is null on every existing row
-- and stays null there.
ALTER TABLE claims DROP CONSTRAINT claims_extraction_run_id_check;
ALTER TABLE claims ADD CONSTRAINT claims_extraction_run
 FOREIGN KEY(owner_scope_id,extraction_run_id) REFERENCES extraction_runs(owner_scope_id,id);
CREATE INDEX claims_extraction_run ON claims(owner_scope_id,extraction_run_id);

-- Extraction reads evidence, so it must pass the evidence gate rather than go
-- around it (ADR 0016 §7). The two model-path purposes are added to the request
-- purposes `evidence_access` admits; every other condition is untouched, so a
-- run still needs a declared data purpose inside the item's allowed purposes and
-- a sensitivity ceiling at or above the item's own, and a transaction that sets
-- neither still reads nothing.
CREATE OR REPLACE FUNCTION unai_private.evidence_access(purposes text[], sensitivity text) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT current_setting('unai.purpose',true) IN ('evidence.ingest','evidence.read','connector.read','memory.extract','memory.canonicalize')
 AND current_setting('unai.data_purpose',true)=ANY(purposes)
 AND array_position(ARRAY['NORMAL','PRIVATE','RESTRICTED'],sensitivity)
 <= array_position(ARRAY['NORMAL','PRIVATE','RESTRICTED'],current_setting('unai.maximum_sensitivity',true))
$$;

-- Purposes. `evidence.ingest` records triage because the decision is taken in the
-- ingest transaction; `evidence.read` reads route and reason back on the evidence
-- read; `memory.extract` opens and closes a run; `memory.canonicalize` writes the
-- claims and completes the run atomically with them; `model.call` is the
-- gateway's own accounting purpose and reaches nothing else.
CREATE FUNCTION unai_private.extraction_purpose(allowed text[]) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog
AS $$ SELECT current_setting('unai.purpose',true) = ANY(allowed) $$;
REVOKE ALL ON FUNCTION unai_private.extraction_purpose(text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION unai_private.extraction_purpose(text[]) TO unai_app;

ALTER TABLE triage_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE triage_decisions FORCE ROW LEVEL SECURITY;
-- The EXISTS is the point, not a formality: `tier0_parsed` holds text taken from
-- the item, so a triage row is readable exactly when its evidence is. A session
-- that may not read the source item reads no route derived from it either.
CREATE POLICY owner_read ON triage_decisions FOR SELECT TO unai_app
 USING(unai_private.has_owner_access(owner_scope_id)
 AND unai_private.extraction_purpose(ARRAY['evidence.read','evidence.ingest','memory.extract','memory.canonicalize'])
 AND EXISTS(SELECT 1 FROM source_items s WHERE s.owner_scope_id=triage_decisions.owner_scope_id AND s.id=source_item_id));
-- Written in the ingest transaction, which is the only place a route is decided
-- today; a later caller that routes under its own purpose adds it here.
CREATE POLICY owner_append ON triage_decisions FOR INSERT TO unai_app
 WITH CHECK(unai_private.has_owner_access(owner_scope_id)
 AND unai_private.extraction_purpose(ARRAY['evidence.ingest'])
 AND EXISTS(SELECT 1 FROM source_items s WHERE s.owner_scope_id=triage_decisions.owner_scope_id AND s.id=source_item_id));
GRANT SELECT,INSERT ON triage_decisions TO unai_app;

ALTER TABLE extraction_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE extraction_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_read ON extraction_runs FOR SELECT TO unai_app
 USING(unai_private.has_owner_access(owner_scope_id)
 AND unai_private.extraction_purpose(ARRAY['memory.extract','memory.canonicalize','memory.inspect']));
CREATE POLICY owner_append ON extraction_runs FOR INSERT TO unai_app
 WITH CHECK(unai_private.has_owner_access(owner_scope_id)
 AND unai_private.extraction_purpose(ARRAY['memory.extract','memory.canonicalize']));
-- A run is opened RUNNING and closed once. Only the outcome columns may move;
-- the versions it ran under are immutable, enforced by the trigger below.
CREATE POLICY owner_close ON extraction_runs FOR UPDATE TO unai_app
 USING(unai_private.has_owner_access(owner_scope_id) AND status='RUNNING'
 AND unai_private.extraction_purpose(ARRAY['memory.extract','memory.canonicalize']))
 WITH CHECK(unai_private.has_owner_access(owner_scope_id)
 AND unai_private.extraction_purpose(ARRAY['memory.extract','memory.canonicalize']));
GRANT SELECT,INSERT ON extraction_runs TO unai_app;
GRANT UPDATE(status,model_provider,model_id,prompt_version,cost_microunits,latency_ms,completed_at,error_code) ON extraction_runs TO unai_app;

ALTER TABLE model_call_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE model_call_records FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_read ON model_call_records FOR SELECT TO unai_app
 USING(unai_private.has_owner_access(owner_scope_id)
 AND unai_private.extraction_purpose(ARRAY['model.call','memory.extract','memory.canonicalize','memory.inspect']));
CREATE POLICY owner_append ON model_call_records FOR INSERT TO unai_app
 WITH CHECK(unai_private.has_owner_access(owner_scope_id)
 AND unai_private.extraction_purpose(ARRAY['model.call']));
GRANT SELECT,INSERT ON model_call_records TO unai_app;

-- A run records the versions it ran under; a closing write may not rewrite them
-- into a different run (PRD §42: past state is never rewritten).
CREATE FUNCTION unai_private.extraction_run_close_only() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF NEW.id<>OLD.id OR NEW.owner_scope_id<>OLD.owner_scope_id OR NEW.source_item_id<>OLD.source_item_id
  OR NEW.triage_decision_id<>OLD.triage_decision_id OR NEW.run_kind<>OLD.run_kind
  OR NEW.registry_release_id<>OLD.registry_release_id OR NEW.normalization_version<>OLD.normalization_version
  OR NEW.entity_resolver_version<>OLD.entity_resolver_version
  OR NEW.temporal_resolver_version<>OLD.temporal_resolver_version OR NEW.started_at<>OLD.started_at THEN
  RAISE EXCEPTION 'EXTRACTION_RUN_IMMUTABLE' USING ERRCODE='55000';
 END IF;
 IF OLD.status<>'RUNNING' THEN
  RAISE EXCEPTION 'EXTRACTION_RUN_ALREADY_CLOSED' USING ERRCODE='55000';
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION unai_private.extraction_run_close_only() FROM PUBLIC;
CREATE TRIGGER extraction_run_close_only BEFORE UPDATE ON extraction_runs
 FOR EACH ROW EXECUTE FUNCTION unai_private.extraction_run_close_only();

-- Triage decisions and model call records are statements about a moment; neither
-- takes an UPDATE grant, so neither can be revised after the fact.
CREATE TRIGGER triage_decision_immutable BEFORE UPDATE ON triage_decisions
 FOR EACH ROW EXECUTE FUNCTION unai_private.immutable_evidence();
CREATE TRIGGER model_call_record_immutable BEFORE UPDATE ON model_call_records
 FOR EACH ROW EXECUTE FUNCTION unai_private.immutable_evidence();

-- The extraction service cuts a narrower anchor inside the parser's anchor for
-- each claim it produces (ADR 0016 §5). The delivered `evidence.ingest` policy is
-- untouched; this is a second INSERT path carrying the same owner-access and
-- existing-source-item conditions, so it widens who may anchor and weakens
-- nothing. The identity index still makes a re-derived anchor a no-op.
CREATE POLICY anchor_append_extraction ON source_anchors FOR INSERT TO unai_app
 WITH CHECK(unai_private.has_owner_access(owner_scope_id)
 AND unai_private.extraction_purpose(ARRAY['memory.canonicalize'])
 AND EXISTS(SELECT 1 FROM source_items s WHERE s.owner_scope_id=source_anchors.owner_scope_id AND s.id=source_item_id));
-- source_anchors already grants INSERT to unai_app (migration 0008); the read
-- path the extractor needs is the delivered `anchor_read` policy, which gates on
-- owner access alone, so no read policy changes here.
