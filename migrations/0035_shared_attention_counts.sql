-- One attention budget spans Inbox, Mentor and initiative. Counting a shown
-- item does not grant permission to read its source, receipt or private text.
CREATE FUNCTION unai_private.proactive_attention_counts(requested_owner uuid, requested_day date)
RETURNS TABLE(sensitivity_scope text,n bigint)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF requested_day IS NULL OR NOT coalesce(unai_private.has_owner_access(requested_owner),false)
   OR NOT coalesce(unai_private.memory_purpose(ARRAY['memory.inbox','mentor.advise']),false) THEN
  RETURN;
 END IF;
 RETURN QUERY
 SELECT items.scope,count(*) FROM (
  SELECT c.sensitivity_scope AS scope FROM public.clarification_cards c
   WHERE c.owner_scope_id=requested_owner AND c.asked_on=requested_day
  UNION ALL
  SELECT m.sensitivity_scope FROM public.mentor_cards m
   WHERE m.owner_scope_id=requested_owner AND m.owner_local_date=requested_day AND m.decision='ASK'
  UNION ALL
  SELECT CASE WHEN r.attention_inputs->>'sensitivityScope' ~ '^(FINANCE|FAMILY|WORK|HEALTH|ADMIN|PERSONAL)/(NORMAL|PRIVATE|RESTRICTED)$'
    THEN r.attention_inputs->>'sensitivityScope' ELSE 'PERSONAL/RESTRICTED' END
   FROM public.initiative_receipts r
   WHERE r.owner_scope_id=requested_owner AND r.owner_local_date=requested_day AND r.attention_decision='ASK'
 ) items GROUP BY items.scope ORDER BY items.scope;
END $$;
REVOKE ALL ON FUNCTION unai_private.proactive_attention_counts(uuid,date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION unai_private.proactive_attention_counts(uuid,date) TO unai_app;
CREATE INDEX initiative_receipts_attention_day ON initiative_receipts(owner_scope_id,owner_local_date)
 WHERE attention_decision='ASK';
