-- ADR 0033: a recorded computation requires all its inputs. Erasure invalidates
-- broken derivations, preserves only independently grounded output, and clears
-- affected caches even when independent support preserves the canonical value.
-- Replace only the existing owner/purpose-checked definer; its privileges,
-- receipt and transaction boundary remain unchanged. Applied 0024 is immutable.

CREATE OR REPLACE FUNCTION unai_private.erase_evidence(owner uuid, evidence uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE
 raw_ref text;
 anchor_ids uuid[]; run_ids uuid[]; claim_ids uuid[]; proposition_ids uuid[] := '{}'; added uuid[];
 live_claim_ids uuid[]; grounded_ids uuid[] := '{}'; dependency_ids uuid[] := '{}'; new_dependencies uuid[];
 affected_ids uuid[] := '{}'; cache_ids uuid[]; cache_added uuid[];
 steps bigint; max_steps bigint; proposition_count bigint;
 frame_ids uuid[]; link_ids uuid[]; resolution_ids uuid[]; erased_ids uuid[];
 edition_ids uuid[]; card_ids uuid[]; named_ids text[];
 counts jsonb := '{}'::jsonb; n integer; derived integer := 0;
BEGIN
 IF NOT unai_private.has_owner_access(owner) OR current_setting('unai.purpose',true) IS DISTINCT FROM 'data.delete' THEN
  RAISE EXCEPTION 'ERASURE_NOT_AUTHORIZED' USING ERRCODE='42501';
 END IF;
 SELECT raw_object_ref INTO raw_ref FROM public.source_items
  WHERE owner_scope_id=owner AND id=evidence AND deleted_at IS NULL FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'ERASURE_EVIDENCE_NOT_FOUND' USING ERRCODE='P0002'; END IF;

 SELECT coalesce(array_agg(id),'{}') INTO anchor_ids FROM public.source_anchors
  WHERE owner_scope_id=owner AND source_item_id=evidence;
 SELECT coalesce(array_agg(id),'{}') INTO run_ids FROM public.extraction_runs
  WHERE owner_scope_id=owner AND source_item_id=evidence;
 SELECT coalesce(array_agg(id),'{}') INTO claim_ids FROM public.claims
  WHERE owner_scope_id=owner AND (source_anchor_id=ANY(anchor_ids) OR extraction_run_id=ANY(run_ids));

 -- Grounded support is a least fixed point, not merely a set of existing
 -- input rows. A cycle of computations cannot replace its erased source.
 SELECT count(*) INTO proposition_count FROM public.propositions WHERE owner_scope_id=owner;
 SELECT coalesce(array_agg(c.id),'{}') INTO live_claim_ids FROM public.claims c
  JOIN public.source_anchors a ON a.owner_scope_id=c.owner_scope_id AND a.id=c.source_anchor_id
  JOIN public.source_items s ON s.owner_scope_id=a.owner_scope_id AND s.id=a.source_item_id
  WHERE c.owner_scope_id=owner AND NOT (c.id=ANY(claim_ids))
   AND c.lifecycle NOT IN ('REJECTED','SUPERSEDED','SUPPRESSED')
   AND s.deleted_at IS NULL AND s.id<>evidence
   AND s.actor_ref->>'type' IS DISTINCT FROM 'ASSISTANT';
 SELECT coalesce(array_agg(DISTINCT c.proposition_id),'{}') INTO grounded_ids FROM public.claims c
  WHERE c.owner_scope_id=owner AND c.id=ANY(live_claim_ids) AND c.proposition_id IS NOT NULL;
 steps := 0;
 LOOP
  steps := steps+1;
  IF steps>proposition_count+1 THEN
   RAISE EXCEPTION 'ERASURE_GROUNDING_DID_NOT_CONVERGE' USING ERRCODE='55000';
  END IF;
  SELECT coalesce(array_agg(p.id),'{}') INTO added FROM public.propositions p
   WHERE p.owner_scope_id=owner AND NOT (p.id=ANY(grounded_ids))
    AND (EXISTS(SELECT 1 FROM public.belief_support s WHERE s.owner_scope_id=owner
      AND s.proposition_id=p.id AND s.support_kind='DIRECT_ASSERTION'
      AND (s.claim_id=ANY(live_claim_ids) OR s.supporting_proposition_id=ANY(grounded_ids)))
     OR EXISTS(SELECT 1 FROM public.derived_proposition_dependencies d WHERE d.owner_scope_id=owner
      AND d.derived_proposition_id=p.id
      AND NOT EXISTS(SELECT 1 FROM unnest(d.input_claim_ids) AS i(id) WHERE i.id IS NULL OR NOT (i.id=ANY(live_claim_ids)))
      AND NOT EXISTS(SELECT 1 FROM unnest(d.input_proposition_ids) AS i(id) WHERE i.id IS NULL OR NOT (i.id=ANY(grounded_ids)))));
  EXIT WHEN cardinality(added)=0;
  grounded_ids := grounded_ids || added;
 END LOOP;

 -- One dependency row is one computation requiring every recorded input.
 -- Invalidate a broken row even when independent support preserves its output.
 -- Checking actual row existence also reaches orphan inputs from earlier erasure.
 SELECT proposition_count+count(*)+1 INTO max_steps FROM public.derived_proposition_dependencies WHERE owner_scope_id=owner;
 steps := 0;
 LOOP
  steps := steps+1;
  IF steps>max_steps THEN
   RAISE EXCEPTION 'ERASURE_DERIVATION_DID_NOT_CONVERGE' USING ERRCODE='55000';
  END IF;
  SELECT coalesce(array_agg(d.id),'{}') INTO new_dependencies FROM public.derived_proposition_dependencies d
   WHERE d.owner_scope_id=owner AND NOT (d.id=ANY(dependency_ids))
    AND (EXISTS(SELECT 1 FROM unnest(d.input_claim_ids) AS i(id) WHERE i.id IS NULL OR i.id=ANY(claim_ids)
      OR NOT EXISTS(SELECT 1 FROM public.claims c WHERE c.owner_scope_id=owner AND c.id=i.id))
     OR EXISTS(SELECT 1 FROM unnest(d.input_proposition_ids) AS i(id) WHERE i.id IS NULL OR i.id=ANY(proposition_ids)
      OR NOT EXISTS(SELECT 1 FROM public.propositions p WHERE p.owner_scope_id=owner AND p.id=i.id)));
  dependency_ids := dependency_ids || new_dependencies;
  SELECT coalesce(array_agg(DISTINCT derived_proposition_id),'{}') INTO affected_ids
   FROM public.derived_proposition_dependencies WHERE owner_scope_id=owner AND id=ANY(dependency_ids);
  SELECT coalesce(array_agg(p.id),'{}') INTO added FROM public.propositions p
   WHERE p.owner_scope_id=owner AND NOT (p.id=ANY(proposition_ids)) AND NOT (p.id=ANY(grounded_ids))
    AND (p.id=ANY(affected_ids)
     OR EXISTS(SELECT 1 FROM public.claims c WHERE c.owner_scope_id=owner AND c.proposition_id=p.id AND c.id=ANY(claim_ids))
     OR EXISTS(SELECT 1 FROM public.belief_support s WHERE s.owner_scope_id=owner AND s.proposition_id=p.id
       AND (s.claim_id=ANY(claim_ids) OR s.supporting_proposition_id=ANY(proposition_ids))));
  EXIT WHEN cardinality(added)=0 AND cardinality(new_dependencies)=0;
  proposition_ids := proposition_ids || added;
  -- Rejected or otherwise ungrounded claims attached to a removed output are
  -- derivatives too; include them before following downstream claim inputs.
  claim_ids := claim_ids || coalesce((SELECT array_agg(c.id) FROM public.claims c
   WHERE c.owner_scope_id=owner AND c.proposition_id=ANY(added) AND NOT (c.id=ANY(claim_ids))),'{}');
 END LOOP;

 -- Every deleted dependency identity participates in payload invalidation,
 -- including a row removed with an ungrounded output rather than its operands.
 dependency_ids := dependency_ids || coalesce((SELECT array_agg(d.id) FROM public.derived_proposition_dependencies d
  WHERE d.owner_scope_id=owner AND d.derived_proposition_id=ANY(proposition_ids)
   AND NOT (d.id=ANY(dependency_ids))),'{}');

 -- A cache can quote the broken computation without naming its inputs. Clear
 -- affected outputs and their downstream caches even when their values survive
 -- on independent evidence. Canonical removal continues to use proposition_ids.
 SELECT coalesce(array_agg(DISTINCT id),'{}') INTO cache_ids FROM unnest(affected_ids || proposition_ids) AS ids(id);
 steps := 0;
 LOOP
  steps := steps+1;
  IF steps>proposition_count+1 THEN
   RAISE EXCEPTION 'ERASURE_CACHE_DID_NOT_CONVERGE' USING ERRCODE='55000';
  END IF;
  SELECT coalesce(array_agg(p.id),'{}') INTO cache_added FROM public.propositions p
   WHERE p.owner_scope_id=owner AND NOT (p.id=ANY(cache_ids))
    AND (EXISTS(SELECT 1 FROM public.derived_proposition_dependencies d WHERE d.owner_scope_id=owner
      AND d.derived_proposition_id=p.id AND (d.input_proposition_ids && cache_ids
       OR EXISTS(SELECT 1 FROM public.claims c WHERE c.owner_scope_id=owner
        AND c.id=ANY(d.input_claim_ids) AND c.proposition_id=ANY(cache_ids))))
     OR EXISTS(SELECT 1 FROM public.belief_support s WHERE s.owner_scope_id=owner
      AND s.proposition_id=p.id AND s.supporting_proposition_id=ANY(cache_ids)));
  EXIT WHEN cardinality(cache_added)=0;
  cache_ids := cache_ids || cache_added;
 END LOOP;

 SELECT coalesce(array_agg(id),'{}') INTO link_ids FROM public.memory_links
  WHERE owner_scope_id=owner AND (from_object_id=ANY(claim_ids||proposition_ids||evidence)
   OR to_object_id=ANY(claim_ids||proposition_ids||evidence));
 SELECT coalesce(array_agg(id),'{}') INTO resolution_ids FROM public.resolution_assertions
  WHERE owner_scope_id=owner AND (claim_id=ANY(claim_ids) OR source_proposition_id=ANY(proposition_ids)
   OR target_proposition_id=ANY(proposition_ids) OR resolution_link_id=ANY(link_ids));
 -- A link that pointed at a removed resolution goes with it.
 link_ids := link_ids || coalesce((SELECT array_agg(id) FROM public.memory_links
  WHERE owner_scope_id=owner AND NOT (id=ANY(link_ids))
   AND (from_object_id=ANY(resolution_ids) OR to_object_id=ANY(resolution_ids))),'{}');

 -- Every frame whose projection row could carry a removed value.
 SELECT coalesce(array_agg(DISTINCT f),'{}') INTO frame_ids FROM (
   SELECT sl.frame_instance_id AS f FROM public.propositions p
    JOIN public.belief_slots sl ON sl.owner_scope_id=p.owner_scope_id AND sl.id=p.belief_slot_id
    WHERE p.owner_scope_id=owner AND p.id=ANY(cache_ids)
   UNION SELECT frame_instance_id FROM public.frame_instance_roles WHERE owner_scope_id=owner AND claim_id=ANY(claim_ids)
   UNION SELECT source_frame_instance_id FROM public.resolution_assertions WHERE owner_scope_id=owner AND id=ANY(resolution_ids)
   UNION SELECT target_frame_instance_id FROM public.resolution_assertions
    WHERE owner_scope_id=owner AND id=ANY(resolution_ids) AND target_frame_instance_id IS NOT NULL) AS frames;

 DELETE FROM public.open_commitments_projection WHERE owner_scope_id=owner AND commitment_frame_instance_id=ANY(frame_ids);
 GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('projectionRows', n);
 DELETE FROM public.obligations_projection WHERE owner_scope_id=owner AND obligation_frame_instance_id=ANY(frame_ids);
 GET DIAGNOSTICS n = ROW_COUNT; counts := jsonb_set(counts,'{projectionRows}',to_jsonb((counts->>'projectionRows')::int+n));
 DELETE FROM public.schedule_projection WHERE owner_scope_id=owner AND (scheduled_frame_instance_id=ANY(frame_ids)
  OR outcome_resolution_id=ANY(resolution_ids) OR realization_link_id=ANY(link_ids));
 GET DIAGNOSTICS n = ROW_COUNT; counts := jsonb_set(counts,'{projectionRows}',to_jsonb((counts->>'projectionRows')::int+n));

 DELETE FROM public.memory_embeddings WHERE owner_scope_id=owner
  AND (object_id=ANY(claim_ids) OR proposition_id=ANY(cache_ids) OR source_item_ids && ARRAY[evidence]);
 GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('embeddings', n);
 DELETE FROM public.memory_thread_members WHERE owner_scope_id=owner
  AND ((object_type='claim' AND object_id=ANY(claim_ids)) OR (object_type='proposition' AND object_id=ANY(proposition_ids))
   OR (object_type='resolution_assertion' AND object_id=ANY(resolution_ids)));
 GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('threadMemberships', n);
 DELETE FROM public.resolution_assertions WHERE owner_scope_id=owner AND id=ANY(resolution_ids);
 GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('resolutionAssertions', n);
 DELETE FROM public.memory_links WHERE owner_scope_id=owner AND id=ANY(link_ids);
 GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('links', n);
 DELETE FROM public.belief_support WHERE owner_scope_id=owner
  AND (claim_id=ANY(claim_ids) OR proposition_id=ANY(proposition_ids) OR supporting_proposition_id=ANY(proposition_ids)
   OR (support_kind='DERIVATION' AND proposition_id=ANY(affected_ids)));
 GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('supportRows', n);
 DELETE FROM public.claim_relations WHERE owner_scope_id=owner
  AND (from_claim_id=ANY(claim_ids) OR to_claim_id=ANY(claim_ids));
 DELETE FROM public.frame_instance_roles WHERE owner_scope_id=owner AND claim_id=ANY(claim_ids);
 DELETE FROM public.instance_match_candidates WHERE owner_scope_id=owner
  AND (claim_id=ANY(claim_ids) OR extraction_run_id=ANY(run_ids));
 DELETE FROM public.derived_proposition_dependencies WHERE owner_scope_id=owner
  AND (derived_proposition_id=ANY(proposition_ids) OR id=ANY(dependency_ids));
 DELETE FROM public.belief_assessments WHERE owner_scope_id=owner AND proposition_id=ANY(proposition_ids);
 GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('beliefAssessments', n);
 DELETE FROM public.proposition_fingerprints WHERE owner_scope_id=owner AND proposition_id=ANY(proposition_ids);
 DELETE FROM public.proposition_lineage WHERE owner_scope_id=owner
  AND (from_proposition_id=ANY(proposition_ids) OR to_proposition_id=ANY(proposition_ids));
 DELETE FROM public.claims WHERE owner_scope_id=owner AND id=ANY(claim_ids);
 GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('claims', n);
 DELETE FROM public.propositions WHERE owner_scope_id=owner AND id=ANY(proposition_ids);
 GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('unsupportedBeliefs', n);
 DELETE FROM public.model_call_records WHERE owner_scope_id=owner AND extraction_run_id=ANY(run_ids);
 DELETE FROM public.extraction_runs WHERE owner_scope_id=owner AND id=ANY(run_ids);
 GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('extractionRuns', n);
 DELETE FROM public.triage_decisions WHERE owner_scope_id=owner AND source_item_id=evidence;
 GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('parsedContent', n);
 DELETE FROM public.source_anchors WHERE owner_scope_id=owner AND id=ANY(anchor_ids);
 GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('anchors', n);
 DELETE FROM public.evidence_ingestion_receipts WHERE owner_scope_id=owner AND source_item_id=evidence;
 DELETE FROM public.entity_aliases WHERE owner_scope_id=owner AND source_item_id=evidence;
 GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('aliases', n);

 erased_ids := ARRAY[evidence] || anchor_ids || claim_ids || cache_ids || resolution_ids || dependency_ids;
 DELETE FROM public.memory_summaries WHERE owner_scope_id=owner AND source_object_ids && erased_ids;
 GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('summaries', n);

 UPDATE public.owner_overlay_deltas SET raw_text='[erased]'
  WHERE owner_scope_id=owner AND source_evidence_id=evidence AND raw_text<>'[erased]';
 GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('overlayTextsErased', n);
 UPDATE public.belief_transaction_operations o SET payload='{"erased":true}'::jsonb
  WHERE o.owner_scope_id=owner AND o.payload<>'{"erased":true}'::jsonb
   AND (EXISTS(SELECT 1 FROM public.belief_transactions t WHERE t.owner_scope_id=owner
      AND t.id=o.belief_transaction_id AND evidence=ANY(t.source_evidence_ids))
    OR EXISTS(SELECT 1 FROM unnest(erased_ids) AS i(id)
      WHERE strpos(o.payload::text, i.id::text)>0 OR strpos(coalesce(o.result_object_refs::text,''), i.id::text)>0));
 GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('transactionPayloadsErased', n);
 UPDATE public.context_packets p SET packet='{"erased":true}'::jsonb, request='{"erased":true}'::jsonb
  WHERE p.owner_scope_id=owner AND p.packet<>'{"erased":true}'::jsonb
   AND EXISTS(SELECT 1 FROM unnest(erased_ids) AS i(id) WHERE strpos(p.packet::text, i.id::text)>0);
 GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('contextPacketsErased', n);

 -- Records composed from memory that name a removed object: the whole row is
 -- searched as text, so an id held in a manifest, a fact list or a supporting
 -- episode counts as well as one in a column.
 named_ids := ARRAY(SELECT unnest(erased_ids || frame_ids)::text);
 SELECT coalesce(array_agg(e.id),'{}') INTO edition_ids FROM public.briefing_editions e
  WHERE e.owner_scope_id=owner AND (EXISTS(SELECT 1 FROM unnest(named_ids) AS i(id) WHERE strpos(to_jsonb(e)::text, i.id)>0)
   OR EXISTS(SELECT 1 FROM public.briefing_items b WHERE b.owner_scope_id=owner AND b.briefing_edition_id=e.id
    AND EXISTS(SELECT 1 FROM unnest(named_ids) AS i(id) WHERE strpos(to_jsonb(b)::text, i.id)>0)));
 DELETE FROM public.briefing_items WHERE owner_scope_id=owner AND briefing_edition_id=ANY(edition_ids);
 GET DIAGNOSTICS n = ROW_COUNT; derived := derived+n;
 DELETE FROM public.briefing_editions WHERE owner_scope_id=owner AND id=ANY(edition_ids);
 GET DIAGNOSTICS n = ROW_COUNT; derived := derived+n;
 SELECT coalesce(array_agg(c.id),'{}') INTO card_ids FROM public.clarification_cards c
  WHERE c.owner_scope_id=owner AND (c.reopened_by_evidence_id=evidence
   OR EXISTS(SELECT 1 FROM unnest(named_ids) AS i(id) WHERE strpos(to_jsonb(c)::text, i.id)>0));
 DELETE FROM public.interruption_decisions WHERE owner_scope_id=owner AND clarification_card_id=ANY(card_ids);
 GET DIAGNOSTICS n = ROW_COUNT; derived := derived+n;
 DELETE FROM public.clarification_cards WHERE owner_scope_id=owner AND id=ANY(card_ids);
 GET DIAGNOSTICS n = ROW_COUNT; derived := derived+n;
 DELETE FROM public.weekly_reviews w WHERE w.owner_scope_id=owner
  AND EXISTS(SELECT 1 FROM unnest(named_ids) AS i(id) WHERE strpos(to_jsonb(w)::text, i.id)>0);
 GET DIAGNOSTICS n = ROW_COUNT; derived := derived+n;
 DELETE FROM public.behavioral_observations o WHERE o.owner_scope_id=owner
  AND EXISTS(SELECT 1 FROM unnest(named_ids) AS i(id) WHERE strpos(to_jsonb(o)::text, i.id)>0);
 GET DIAGNOSTICS n = ROW_COUNT; derived := derived+n;
 counts := counts || jsonb_build_object('derivedRecords', derived);

 UPDATE public.source_items SET deleted_at=clock_timestamp(), external_id='erased:'||id::text,
   idempotency_key='erased:'||id::text, content_hash=encode(sha256(convert_to('erased:'||id::text,'UTF8')),'hex'),
   parent_external_id=NULL, occurred_at=NULL, actor_ref='{}'::jsonb, deterministic_metadata='{}'::jsonb
  WHERE owner_scope_id=owner AND id=evidence;
 UPDATE public.evidence_object_keys SET deleted_at=clock_timestamp()
  WHERE owner_scope_id=owner AND source_item_id=evidence AND deleted_at IS NULL;

 RETURN jsonb_build_object('evidenceId', evidence, 'rawObjectRef', raw_ref, 'counts', counts,
  'claimIds', to_jsonb(claim_ids), 'propositionIds', to_jsonb(proposition_ids),
  'resolutionAssertionIds', to_jsonb(resolution_ids), 'frameInstanceIds', to_jsonb(frame_ids));
END
$$;
