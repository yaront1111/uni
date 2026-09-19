-- A source-authorized related_goal role is not evidence that the goal remains
-- active. The broker intersects such links with this content-free owner read.
-- Goals' mutable priority/override fields are caches, not historical authority.
CREATE FUNCTION unai_private.active_goal_priorities(
 requested_owner uuid, requested_goal_ids uuid[], world_time timestamptz, knowledge_time timestamptz
) RETURNS TABLE(goal_id uuid, priority text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF NOT coalesce(unai_private.has_owner_access(requested_owner),false)
   OR NOT coalesce(unai_private.memory_purpose(ARRAY['memory.read','memory.inspect']),false)
   OR requested_goal_ids IS NULL OR cardinality(requested_goal_ids) NOT BETWEEN 1 AND 500
   OR world_time IS NULL OR knowledge_time IS NULL
   OR NOT isfinite(world_time) OR NOT isfinite(knowledge_time) THEN
  RETURN;
 END IF;
 RETURN QUERY
 WITH standing AS (
  SELECT g.id AS goal_id,h.priority,h.change_kind,h.recorded_at
  FROM public.goals g
  CROSS JOIN LATERAL (
   SELECT h.priority,h.change_kind,h.recorded_at FROM public.goal_priority_history h
   WHERE h.owner_scope_id=requested_owner AND h.goal_id=g.id
    AND h.change_kind IN ('INITIAL','CHANGE') AND h.recorded_at<=knowledge_time
    AND h.valid_from<=world_time AND (h.valid_to IS NULL OR world_time<h.valid_to)
   ORDER BY h.recorded_at DESC,h.valid_from DESC,h.id DESC LIMIT 1
  ) h
  WHERE g.owner_scope_id=requested_owner AND g.id=ANY(requested_goal_ids)
   AND g.created_at<=knowledge_time AND g.created_at<=world_time
   -- Retirement has no recorded-time journal. It remains a present control;
   -- historical queries must not manufacture an active goal from that gap.
   AND g.retired_at IS NULL
 ), effective AS (
  SELECT s.goal_id,CASE
   -- A later standing change cancels the previously recorded override, even
   -- when its original window has not expired. Initial overrides deliberately
   -- share the initial statement's transaction timestamp (createGoal).
   WHEN o.recorded_at>s.recorded_at OR (o.recorded_at=s.recorded_at AND s.change_kind='INITIAL')
    THEN CASE WHEN world_time<o.valid_to THEN o.priority ELSE s.priority END
   -- No append sequence exists for a CHANGE and an override recorded in the
   -- same transaction. Do not infer their order from an opaque random ID.
   WHEN o.recorded_at=s.recorded_at THEN NULL::text
   ELSE s.priority END AS priority
  FROM standing s
  LEFT JOIN LATERAL (
   SELECT h.priority,h.valid_to,h.recorded_at FROM public.goal_priority_history h
   WHERE h.owner_scope_id=requested_owner AND h.goal_id=s.goal_id
    AND h.change_kind='TEMPORARY_OVERRIDE' AND h.recorded_at<=knowledge_time AND h.valid_from<=world_time
   -- Select the latest override before checking expiry. An expired replacement
   -- falls back to standing priority; it never revives an older override.
   ORDER BY h.recorded_at DESC,h.valid_from DESC,h.id DESC LIMIT 1
  ) o ON true
 )
 SELECT e.goal_id,e.priority FROM effective e WHERE e.priority IN ('HIGH','MEDIUM','LOW') ORDER BY e.goal_id;
END $$;
REVOKE ALL ON FUNCTION unai_private.active_goal_priorities(uuid,uuid[],timestamptz,timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION unai_private.active_goal_priorities(uuid,uuid[],timestamptz,timestamptz) TO unai_app;
