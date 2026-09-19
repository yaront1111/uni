-- ADR 0037. Policy metadata belongs to the exact immutable registry snapshot.
-- No source content, unrelated contract body or latest-release fallback is exposed.
CREATE FUNCTION unai_private.aging_policy(requested_release uuid, requested_predicate text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE release_version text; release_hash text; policy jsonb;
BEGIN
 IF NOT coalesce(unai_private.has_owner_access(unai_private.owner_id()),false)
   OR NOT coalesce(unai_private.memory_purpose(ARRAY['memory.read','memory.inspect']),false) THEN
  RETURN NULL;
 END IF;
 -- Acquire the release relation before the contract relation, matching registry
 -- publication and immutable-snapshot verification lock order.
 SELECT r.semantic_version,r.content_hash INTO release_version,release_hash
  FROM public.registry_releases r WHERE r.id=requested_release AND r.lifecycle='RELEASED';
 IF NOT FOUND THEN RETURN NULL; END IF;
 SELECT c.content->'agingPolicy' INTO policy FROM public.registry_contracts c
  WHERE c.registry_release_id=requested_release AND c.contract_id=requested_predicate AND c.contract_kind='PREDICATE';
 IF policy IS NULL OR jsonb_typeof(policy)<>'object' THEN RETURN NULL; END IF;
 RETURN jsonb_build_object('releaseId',requested_release,'releaseVersion',release_version,
  'releaseContentHash',release_hash,'policy',policy);
END $$;
REVOKE ALL ON FUNCTION unai_private.aging_policy(uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION unai_private.aging_policy(uuid,text) TO unai_app;
