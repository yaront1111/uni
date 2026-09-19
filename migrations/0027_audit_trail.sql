-- The audit trail behind the Audit log screen (design entity `audit_events`,
-- route `GET /v1/audit-events`; PRD §30.6; CRT-SEC-07-A; ADR 0032).
--
-- 0001 created the table append-only by grant alone: `unai_app` holds SELECT and
-- INSERT and nothing else. This file adds the two design fields the row lacked
-- and makes the append-only rule hold for every role, not only for the
-- application's:
--
--  * `event_kind` -- read, write, projection rebuild, export, deletion or external
--    action. The owner transaction names it on every row it appends; a row a
--    definer function appends (sign-in, sign-out) gets it from the purpose.
--  * `policy_decision_id` -- the recorded policy-port decision the event acted
--    under, where one exists, next to the ALLOW/DENY outcome already stored.
--  * A trigger that refuses UPDATE, DELETE and TRUNCATE with
--    `AUDIT_EVENT_IMMUTABLE` (SQLSTATE 55000), so not even the migration principal
--    rewrites history through a stray statement. The application role is still
--    refused earlier, by privilege (42501).

-- The purpose-only half of `auditEventKindFor` in `@unai/domain`; the API
-- boundary adds the HTTP method. `packages/api/src/audit.test.ts` asserts that
-- both answer the same for every purpose the platform admits.
CREATE FUNCTION unai_private.audit_event_kind(requested_purpose text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT CASE
   WHEN requested_purpose='memory.project' THEN 'PROJECTION_REBUILD'
   WHEN requested_purpose='data.export' THEN 'EXPORT'
   WHEN requested_purpose='data.delete' THEN 'DELETION'
   WHEN requested_purpose='action.execute' THEN 'EXTERNAL_ACTION'
   WHEN requested_purpose IN ('memory.read','memory.inspect','evidence.read','connector.read','projection.read',
     'permissions.read','goals.read','decisions.read','action.read','review.weekly','mentor.advise','device.list','audit.read')
     OR requested_purpose ~ '^ops\.[a-z_.]+\.read$' THEN 'READ'
   ELSE 'WRITE'
 END
$$;
REVOKE ALL ON FUNCTION unai_private.audit_event_kind(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION unai_private.audit_event_kind(text) TO unai_app;

ALTER TABLE audit_events ADD COLUMN event_kind text, ADD COLUMN policy_decision_id uuid;
-- Rows appended before this file carry the kind their purpose names.
UPDATE audit_events SET event_kind=unai_private.audit_event_kind(purpose);
ALTER TABLE audit_events ALTER COLUMN event_kind SET NOT NULL,
  ADD CONSTRAINT audit_events_event_kind
    CHECK (event_kind IN ('READ','WRITE','PROJECTION_REBUILD','EXPORT','DELETION','EXTERNAL_ACTION')),
  ADD CONSTRAINT audit_events_policy_decision
    FOREIGN KEY (owner_scope_id,policy_decision_id) REFERENCES policy_decisions(owner_scope_id,id);
CREATE INDEX audit_events_owner_kind_time ON audit_events(owner_scope_id,event_kind,created_at,id);
-- The Audit log's "filtered to one object" reads by containment.
CREATE INDEX audit_events_objects ON audit_events USING gin (objects_and_fields_accessed jsonb_path_ops);

CREATE FUNCTION unai_private.audit_event_defaults() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF NEW.event_kind IS NULL THEN NEW.event_kind := unai_private.audit_event_kind(NEW.purpose); END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION unai_private.audit_event_defaults() FROM PUBLIC;
CREATE TRIGGER audit_event_defaults BEFORE INSERT ON audit_events
FOR EACH ROW EXECUTE FUNCTION unai_private.audit_event_defaults();

CREATE FUNCTION unai_private.audit_event_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 RAISE EXCEPTION 'AUDIT_EVENT_IMMUTABLE' USING ERRCODE='55000';
END $$;
REVOKE ALL ON FUNCTION unai_private.audit_event_immutable() FROM PUBLIC;
CREATE TRIGGER audit_event_immutable BEFORE UPDATE OR DELETE ON audit_events
FOR EACH ROW EXECUTE FUNCTION unai_private.audit_event_immutable();
CREATE TRIGGER audit_event_no_truncate BEFORE TRUNCATE ON audit_events
FOR EACH STATEMENT EXECUTE FUNCTION unai_private.audit_event_immutable();
