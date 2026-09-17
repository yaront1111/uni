-- Registry runtime snapshot (PRD §33.3, ADR 0011). Git remains the source of truth.
-- Global deployment reference data, published only by the migration principal from
-- an immutable Git tag. The application role receives no privileges.
CREATE TABLE registry_releases (
 id uuid PRIMARY KEY,
 semantic_version text NOT NULL UNIQUE CHECK(semantic_version ~ '^(0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,3})$'),
 git_tag text NOT NULL UNIQUE CHECK(git_tag = 'registry-v' || semantic_version),
 git_commit text NOT NULL CHECK(git_commit ~ '^([a-f0-9]{40}|[a-f0-9]{64})$'),
 content_hash text NOT NULL CHECK(content_hash ~ '^[a-f0-9]{64}$'),
 lifecycle text NOT NULL CHECK(lifecycle IN ('RELEASED')),
 released_at timestamptz CHECK(lifecycle <> 'RELEASED' OR released_at IS NOT NULL),
 manifest jsonb NOT NULL CHECK(jsonb_typeof(manifest)='object'),
 published_by text NOT NULL DEFAULT current_user,
 correlation_id uuid NOT NULL
);
CREATE TABLE registry_contracts (
 id uuid PRIMARY KEY,
 registry_release_id uuid NOT NULL REFERENCES registry_releases(id),
 contract_id text NOT NULL CHECK(contract_id ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
 contract_version text NOT NULL,
 contract_kind text NOT NULL CHECK(contract_kind IN ('FRAME','PREDICATE','TRANSITION')),
 content jsonb NOT NULL CHECK(jsonb_typeof(content)='object'),
 content_hash text NOT NULL CHECK(content_hash ~ '^[a-f0-9]{64}$'),
 UNIQUE(registry_release_id,contract_id)
);

CREATE FUNCTION unai_private.immutable_registry_snapshot() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 RAISE EXCEPTION 'REGISTRY_SNAPSHOT_IMMUTABLE' USING ERRCODE='42501';
END
$$;
REVOKE ALL ON FUNCTION unai_private.immutable_registry_snapshot() FROM PUBLIC;
CREATE TRIGGER registry_releases_immutable BEFORE UPDATE OR DELETE ON registry_releases
 FOR EACH ROW EXECUTE FUNCTION unai_private.immutable_registry_snapshot();
CREATE TRIGGER registry_releases_no_truncate BEFORE TRUNCATE ON registry_releases
 FOR EACH STATEMENT EXECUTE FUNCTION unai_private.immutable_registry_snapshot();
CREATE TRIGGER registry_contracts_immutable BEFORE UPDATE OR DELETE ON registry_contracts
 FOR EACH ROW EXECUTE FUNCTION unai_private.immutable_registry_snapshot();
CREATE TRIGGER registry_contracts_no_truncate BEFORE TRUNCATE ON registry_contracts
 FOR EACH STATEMENT EXECUTE FUNCTION unai_private.immutable_registry_snapshot();

-- Forced RLS with no application policy or grant: fails closed until a reviewed reader exists.
ALTER TABLE registry_releases ENABLE ROW LEVEL SECURITY;
ALTER TABLE registry_releases FORCE ROW LEVEL SECURITY;
ALTER TABLE registry_contracts ENABLE ROW LEVEL SECURITY;
ALTER TABLE registry_contracts FORCE ROW LEVEL SECURITY;
REVOKE ALL ON registry_releases, registry_contracts FROM PUBLIC, unai_app;
