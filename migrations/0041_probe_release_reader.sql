-- ADR 0043 D10. A readiness probe has no session, owner scope or purpose, yet must
-- know whether the pinned registry release is published. Registry releases are
-- global reference data (0006: forced RLS, no policy). This reader answers one
-- boolean and returns no version, hash, contract or owner data.
CREATE FUNCTION unai_private.registry_release_published(release_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT EXISTS(SELECT 1 FROM public.registry_releases r WHERE r.id=release_id AND r.lifecycle='RELEASED')
$$;
REVOKE ALL ON FUNCTION unai_private.registry_release_published(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION unai_private.registry_release_published(uuid) TO unai_app;
