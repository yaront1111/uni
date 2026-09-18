BEGIN;
CREATE EXTENSION IF NOT EXISTS vector;
-- Database roles are cluster-global, so a cluster that already hosts another database
-- of this product already carries them. Create only when absent, then assert the
-- attributes unconditionally: a pre-existing role can never weaken the owner boundary.
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='unai_app') THEN CREATE ROLE unai_app; END IF;
END $$;
ALTER ROLE unai_app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
CREATE SCHEMA unai_private;
REVOKE ALL ON SCHEMA unai_private FROM PUBLIC;
GRANT USAGE ON SCHEMA public, unai_private TO unai_app;

CREATE TABLE users (
  id uuid PRIMARY KEY,
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 120),
  created_at timestamptz NOT NULL DEFAULT now(),
  disabled_at timestamptz
);
CREATE TABLE owner_scopes (
  id uuid PRIMARY KEY,
  scope_kind text NOT NULL CHECK (scope_kind IN ('PERSONAL','ORGANIZATION')),
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 120),
  created_by_user_id uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE TABLE owner_scope_members (
  owner_scope_id uuid NOT NULL REFERENCES owner_scopes(id),
  user_id uuid NOT NULL REFERENCES users(id),
  role text NOT NULL CHECK (role IN ('OWNER','MEMBER')),
  valid_from timestamptz NOT NULL DEFAULT now(),
  valid_to timestamptz,
  PRIMARY KEY (owner_scope_id,user_id),
  CHECK (valid_to IS NULL OR valid_to > valid_from)
);
CREATE TABLE devices (
  id uuid PRIMARY KEY,
  owner_scope_id uuid NOT NULL REFERENCES owner_scopes(id),
  user_id uuid NOT NULL REFERENCES users(id),
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 120),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (owner_scope_id,user_id) REFERENCES owner_scope_members(owner_scope_id,user_id),
  UNIQUE (owner_scope_id,id)
);
CREATE TABLE audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_scope_id uuid NOT NULL REFERENCES owner_scopes(id),
  actor uuid NOT NULL REFERENCES users(id),
  purpose text NOT NULL CHECK (purpose ~ '^[a-z][a-z0-9_.:-]{0,63}$'),
  objects_and_fields_accessed jsonb NOT NULL CHECK (jsonb_typeof(objects_and_fields_accessed)='array'),
  policy_decision text NOT NULL CHECK (policy_decision IN ('ALLOW','DENY')),
  model_or_code_version text NOT NULL CHECK (length(model_or_code_version) BETWEEN 1 AND 120),
  result text NOT NULL CHECK (result IN ('SUCCESS','FAILURE','REFUSED')),
  correlation_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_events_owner_time ON audit_events(owner_scope_id,created_at,id);
CREATE INDEX devices_owner_user ON devices(owner_scope_id,user_id);

-- The migration principal must own these functions and tables and be privileged.
-- Fixed search paths and no dynamic SQL keep the definer boundary narrow.
CREATE FUNCTION unai_private.actor_id() RETURNS uuid
LANGUAGE sql STABLE SET search_path=pg_catalog
AS $$ SELECT nullif(current_setting('unai.actor_id',true),'')::uuid $$;
CREATE FUNCTION unai_private.owner_id() RETURNS uuid
LANGUAGE sql STABLE SET search_path=pg_catalog
AS $$ SELECT nullif(current_setting('unai.owner_scope_id',true),'')::uuid $$;
CREATE FUNCTION unai_private.has_owner_access(requested_owner uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog
AS $$
 SELECT requested_owner = unai_private.owner_id() AND EXISTS (
   SELECT 1 FROM public.owner_scope_members m
   JOIN public.users u ON u.id=m.user_id
   JOIN public.owner_scopes o ON o.id=m.owner_scope_id
   WHERE m.owner_scope_id=requested_owner AND m.user_id=unai_private.actor_id()
     AND m.valid_from<=statement_timestamp()
     AND (m.valid_to IS NULL OR m.valid_to>statement_timestamp())
     AND u.disabled_at IS NULL AND o.deleted_at IS NULL
 )
$$;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA unai_private FROM PUBLIC;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA unai_private TO unai_app;

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;
CREATE POLICY actor_private ON users TO unai_app USING (id=unai_private.actor_id() AND disabled_at IS NULL);

ALTER TABLE owner_scopes ENABLE ROW LEVEL SECURITY;
ALTER TABLE owner_scopes FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_isolation ON owner_scopes TO unai_app USING (unai_private.has_owner_access(id));

ALTER TABLE owner_scope_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE owner_scope_members FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_isolation ON owner_scope_members TO unai_app USING (unai_private.has_owner_access(owner_scope_id));

ALTER TABLE devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE devices FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_isolation ON devices TO unai_app
USING (unai_private.has_owner_access(owner_scope_id) AND user_id=unai_private.actor_id())
WITH CHECK (unai_private.has_owner_access(owner_scope_id) AND user_id=unai_private.actor_id());

ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_events FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_read ON audit_events FOR SELECT TO unai_app USING (unai_private.has_owner_access(owner_scope_id));
CREATE POLICY owner_append ON audit_events FOR INSERT TO unai_app
WITH CHECK (unai_private.has_owner_access(owner_scope_id) AND actor=unai_private.actor_id());

GRANT SELECT ON users,owner_scopes,owner_scope_members TO unai_app;
GRANT SELECT,INSERT,UPDATE ON devices TO unai_app;
GRANT SELECT,INSERT ON audit_events TO unai_app;
COMMIT;

