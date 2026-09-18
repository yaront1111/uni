-- Context spaces (design entity `context_spaces`, PRD §11.6/§17.2) and the
-- reviewed read-only reader for the registry runtime snapshot (ADR 0014).

-- A belief is asserted in a context. BASE is the default owner-visible context;
-- QUOTED exists only by a registry rule (release 0.1.0 defines none) and TEST is
-- for evaluation. Exactly one active BASE per owner scope is a database
-- invariant here, not an application convention: the partial unique index makes
-- a second one impossible, the owner_scopes trigger below makes a missing one
-- impossible, and the update trigger keeps a BASE row from being retired away.
CREATE TABLE context_spaces (
 id uuid PRIMARY KEY,
 owner_scope_id uuid NOT NULL REFERENCES owner_scopes(id),
 context_kind text NOT NULL CHECK(context_kind IN ('BASE','QUOTED','TEST')),
 parent_context_space_id uuid,
 creation_transaction_id uuid,
 lifecycle text NOT NULL DEFAULT 'ACTIVE' CHECK(lifecycle IN ('ACTIVE','RETIRED')),
 created_at timestamptz NOT NULL DEFAULT now(),
 retired_at timestamptz,
 UNIQUE(owner_scope_id,id),
 FOREIGN KEY(owner_scope_id,parent_context_space_id) REFERENCES context_spaces(owner_scope_id,id),
 -- BASE is the root of its owner scope; a derived context names the context it quotes or tests.
 CONSTRAINT context_spaces_base_is_root CHECK((context_kind='BASE') = (parent_context_space_id IS NULL)),
 CONSTRAINT context_spaces_retirement_recorded CHECK((lifecycle='RETIRED') = (retired_at IS NOT NULL))
);
CREATE UNIQUE INDEX context_spaces_one_active_base ON context_spaces(owner_scope_id)
 WHERE context_kind='BASE' AND lifecycle='ACTIVE';
CREATE INDEX context_spaces_owner ON context_spaces(owner_scope_id,context_kind,lifecycle);

CREATE FUNCTION unai_private.base_context_space() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 INSERT INTO public.context_spaces(id,owner_scope_id,context_kind) VALUES(gen_random_uuid(),NEW.id,'BASE');
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION unai_private.base_context_space() FROM PUBLIC;
CREATE TRIGGER owner_scope_base_context AFTER INSERT ON owner_scopes
 FOR EACH ROW EXECUTE FUNCTION unai_private.base_context_space();

CREATE FUNCTION unai_private.context_space_update() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF NEW.id<>OLD.id OR NEW.owner_scope_id<>OLD.owner_scope_id OR NEW.context_kind<>OLD.context_kind
  OR NEW.created_at<>OLD.created_at THEN
  RAISE EXCEPTION 'CONTEXT_SPACE_IDENTITY_IMMUTABLE' USING ERRCODE='55000';
 END IF;
 -- The owner scope always keeps its BASE context: retiring it would leave the
 -- scope with no context to assert a belief in.
 IF OLD.context_kind='BASE' AND NEW.lifecycle<>'ACTIVE' THEN
  RAISE EXCEPTION 'BASE_CONTEXT_SPACE_PERMANENT' USING ERRCODE='55000';
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION unai_private.context_space_update() FROM PUBLIC;
CREATE TRIGGER context_space_update BEFORE UPDATE ON context_spaces
 FOR EACH ROW EXECUTE FUNCTION unai_private.context_space_update();

CREATE FUNCTION unai_private.base_context_space_permanent() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF OLD.context_kind='BASE' THEN
  RAISE EXCEPTION 'BASE_CONTEXT_SPACE_PERMANENT' USING ERRCODE='55000';
 END IF;
 RETURN OLD;
END $$;
REVOKE ALL ON FUNCTION unai_private.base_context_space_permanent() FROM PUBLIC;
CREATE TRIGGER context_space_delete BEFORE DELETE ON context_spaces
 FOR EACH ROW EXECUTE FUNCTION unai_private.base_context_space_permanent();

-- Owner scopes created before this migration get their BASE context now.
INSERT INTO context_spaces(id,owner_scope_id,context_kind)
 SELECT gen_random_uuid(),o.id,'BASE' FROM owner_scopes o
 WHERE NOT EXISTS(SELECT 1 FROM context_spaces c WHERE c.owner_scope_id=o.id AND c.context_kind='BASE');

ALTER TABLE context_spaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE context_spaces FORCE ROW LEVEL SECURITY;
-- Read only for the application: the BASE context is created with its owner
-- scope, and no delivered capability creates a QUOTED or TEST context yet. The
-- node that first needs one adds its own policy with its own purpose.
CREATE POLICY owner_read ON context_spaces FOR SELECT TO unai_app
 USING(unai_private.has_owner_access(owner_scope_id));
GRANT SELECT ON context_spaces TO unai_app;

-- Reviewed runtime reader for the Git registry snapshot (ADR 0011 left this to
-- the release that needs it; ADR 0014 records the decision). The snapshot tables
-- keep forced RLS, no policy and no application privilege: this definer function
-- is the only application-visible path, it reads and returns bounded metadata,
-- and it refuses any transaction without an owner context under the operations
-- registry purpose. Contract bodies stay in Git and are not returned.
CREATE FUNCTION unai_private.registry_snapshot() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 WITH loaded AS (
  SELECT r.* FROM public.registry_releases r
  WHERE unai_private.owner_id() IS NOT NULL
    AND current_setting('unai.purpose',true)='ops.registry.read'
    AND r.lifecycle='RELEASED'
  ORDER BY string_to_array(r.semantic_version,'.')::int[] DESC, r.released_at DESC
  LIMIT 1
 )
 SELECT jsonb_build_object(
  'release', jsonb_build_object('id',l.id,'semanticVersion',l.semantic_version,'gitTag',l.git_tag,
    'gitCommit',l.git_commit,'contentHash',l.content_hash,'lifecycle',l.lifecycle,
    'releasedAt',to_char(l.released_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
  'contracts', coalesce((SELECT jsonb_agg(jsonb_build_object('contractId',c.contract_id,'contractKind',c.contract_kind,
      'contractVersion',c.contract_version,'contentHash',c.content_hash) ORDER BY c.contract_kind,c.contract_id)
    FROM public.registry_contracts c WHERE c.registry_release_id=l.id),'[]'::jsonb))
 FROM loaded l
$$;
REVOKE ALL ON FUNCTION unai_private.registry_snapshot() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION unai_private.registry_snapshot() TO unai_app;
