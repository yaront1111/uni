-- Durable owner-scoped job queue (design entity `jobs`, CRT-NFR-02-A).
-- PostgreSQL is the queue: no broker, no graph database and no separate vector
-- database is introduced. Leases are reclaimable, attempts are bounded, and an
-- exhausted job stays inspectable in the dead-letter list.
CREATE TABLE jobs (
 id uuid PRIMARY KEY,
 owner_scope_id uuid NOT NULL REFERENCES owner_scopes(id),
 job_kind text NOT NULL CHECK(job_kind ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$'),
 payload jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(payload)='object'),
 idempotency_key text NOT NULL CHECK(idempotency_key ~ '^[a-zA-Z0-9_-]{16,128}$'),
 attempt_count integer NOT NULL DEFAULT 0 CHECK(attempt_count >= 0),
 max_attempts integer NOT NULL DEFAULT 3 CHECK(max_attempts BETWEEN 1 AND 10),
 lease_owner text CHECK(lease_owner ~ '^[a-zA-Z0-9_.:-]{1,128}$'),
 lease_expires_at timestamptz,
 status text NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','RUNNING','SUCCEEDED','FAILED','DEAD_LETTER')),
 -- Handler failures are recorded as stable codes: database and provider error
 -- text can contain private values and must never reach the operations console.
 last_error text CHECK(last_error ~ '^[A-Z][A-Z0-9_:.-]{0,199}$'),
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(owner_scope_id,id),
 UNIQUE(owner_scope_id,job_kind,idempotency_key),
 CONSTRAINT jobs_lease_matches_status CHECK((status='RUNNING')=(lease_owner IS NOT NULL)),
 CONSTRAINT jobs_lease_deadline CHECK((lease_owner IS NULL)=(lease_expires_at IS NULL)),
 CONSTRAINT jobs_attempts_bounded CHECK(attempt_count <= max_attempts),
 CONSTRAINT jobs_dead_letter_is_explained CHECK(status<>'DEAD_LETTER' OR (last_error IS NOT NULL AND attempt_count >= max_attempts))
);
CREATE INDEX jobs_queue ON jobs(owner_scope_id,status,created_at,id);
CREATE INDEX jobs_dead_letter ON jobs(owner_scope_id,updated_at,id) WHERE status='DEAD_LETTER';

-- Purpose gate: an authenticated owner session may read or drive the queue only
-- under one of the queue purposes, never under an unrelated product purpose.
CREATE FUNCTION unai_private.job_purpose(allowed text[]) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog
AS $$ SELECT current_setting('unai.purpose',true) = ANY(allowed) $$;
REVOKE ALL ON FUNCTION unai_private.job_purpose(text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION unai_private.job_purpose(text[]) TO unai_app;

ALTER TABLE jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE jobs FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_read ON jobs FOR SELECT TO unai_app
 USING(unai_private.has_owner_access(owner_scope_id)
 AND unai_private.job_purpose(ARRAY['jobs.enqueue','jobs.work','ops.jobs.read','ops.dead_letter.read','ops.dead_letter.retry']));
CREATE POLICY owner_enqueue ON jobs FOR INSERT TO unai_app
 WITH CHECK(unai_private.has_owner_access(owner_scope_id) AND unai_private.job_purpose(ARRAY['jobs.enqueue']));
CREATE POLICY owner_drive ON jobs FOR UPDATE TO unai_app
 USING(unai_private.has_owner_access(owner_scope_id) AND unai_private.job_purpose(ARRAY['jobs.work','ops.dead_letter.retry']))
 WITH CHECK(unai_private.has_owner_access(owner_scope_id) AND unai_private.job_purpose(ARRAY['jobs.work','ops.dead_letter.retry']));
-- No DELETE or TRUNCATE privilege: a dead-lettered job stays inspectable.
GRANT SELECT,INSERT,UPDATE ON jobs TO unai_app;

CREATE FUNCTION unai_private.job_update() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF NEW.id<>OLD.id OR NEW.owner_scope_id<>OLD.owner_scope_id OR NEW.job_kind<>OLD.job_kind
  OR NEW.payload<>OLD.payload OR NEW.idempotency_key<>OLD.idempotency_key OR NEW.created_at<>OLD.created_at THEN
  RAISE EXCEPTION 'JOB_IDENTITY_IMMUTABLE' USING ERRCODE='55000';
 END IF;
 NEW.updated_at:=now();
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION unai_private.job_update() FROM PUBLIC;
CREATE TRIGGER job_update BEFORE UPDATE ON jobs FOR EACH ROW EXECUTE FUNCTION unai_private.job_update();
