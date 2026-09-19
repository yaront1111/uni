-- CRT-NFR-01-A: measurements are append-only owner metadata, never evidence.
CREATE TABLE performance_measurements (
 id uuid PRIMARY KEY,
 owner_scope_id uuid NOT NULL REFERENCES owner_scopes(id),
 run_id uuid NOT NULL,
 scenario text NOT NULL CHECK(scenario IN ('EVIDENCE_INGESTION_ACK','TYPED_PROJECTION_READ','CONTEXT_PACKET_ASSEMBLY')),
 p95_ms double precision NOT NULL CHECK(p95_ms>=0 AND p95_ms<'Infinity'::float8),
 sample_count integer NOT NULL CHECK(sample_count BETWEEN 20 AND 100000),
 concurrency integer NOT NULL CHECK(concurrency BETWEEN 1 AND 128),
 samples_ms double precision[] NOT NULL,
 excludes_llm_generation boolean NOT NULL CHECK(excludes_llm_generation),
 harness_version text NOT NULL CHECK(harness_version='load-harness-0.1.0'),
 correlation_id uuid NOT NULL,
 recorded_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(owner_scope_id,run_id,scenario),
 CHECK(cardinality(samples_ms)=sample_count)
);
CREATE INDEX performance_measurements_owner ON performance_measurements(owner_scope_id,recorded_at DESC);
ALTER TABLE performance_measurements ENABLE ROW LEVEL SECURITY;
ALTER TABLE performance_measurements FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_read ON performance_measurements FOR SELECT TO unai_app
 USING(unai_private.has_owner_access(owner_scope_id) AND current_setting('unai.purpose',true) IN ('performance.record','ops.metrics.read'));
CREATE POLICY owner_append ON performance_measurements FOR INSERT TO unai_app
 WITH CHECK(unai_private.has_owner_access(owner_scope_id) AND current_setting('unai.purpose',true)='performance.record');
GRANT SELECT,INSERT ON performance_measurements TO unai_app;
CREATE TRIGGER performance_measurements_immutable BEFORE UPDATE OR DELETE ON performance_measurements
 FOR EACH ROW EXECUTE FUNCTION unai_private.evaluation_record_immutable();
