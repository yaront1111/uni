-- PRD §16.2-§16.4, §18.7 and FR-041: outcomes commit through the write governor.
-- Re-applies over itself: projection-replay.test.ts replays every migration from 0016.
ALTER TABLE belief_transaction_operations DROP CONSTRAINT belief_transaction_operations_operation_kind_check;
ALTER TABLE belief_transaction_operations ADD CONSTRAINT belief_transaction_operations_operation_kind_check
 CHECK(operation_kind IN ('CREATE_FRAME_INSTANCE','CREATE_SLOT','CREATE_PROPOSITION','ADD_CLAIM','ADD_SUPPORT','SET_BELIEF_ASSESSMENT','DERIVE','QUALIFY','MERGE','SPLIT','SUPPRESS','ARCHIVE','DELETE','RESOLVE'));

-- ADR 0029 §6's registry_transition_contracts() serves the NEWEST release under
-- decisions.record. A belief transaction instead needs its pinned release, with
-- an owner context under memory.govern. All other reads return [], refusing RESOLVE.
-- Read releases before contracts, like registry_contract_present (ADR 0029 §10).
CREATE OR REPLACE FUNCTION unai_private.registry_release_transition_contracts(release_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT coalesce(jsonb_agg(c.content ORDER BY c.contract_id),'[]'::jsonb)
 FROM public.registry_releases r
 JOIN public.registry_contracts c ON c.registry_release_id=r.id
 WHERE unai_private.owner_id() IS NOT NULL
   AND current_setting('unai.purpose',true)='memory.govern'
   AND r.id=release_id AND r.lifecycle='RELEASED' AND c.contract_kind='TRANSITION'
$$;
REVOKE ALL ON FUNCTION unai_private.registry_release_transition_contracts(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION unai_private.registry_release_transition_contracts(uuid) TO unai_app;
