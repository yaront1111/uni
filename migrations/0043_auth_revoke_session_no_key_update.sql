-- auth_revoke_session locks the user row FOR NO KEY UPDATE instead of 0002's FOR UPDATE.
--
-- POST /v1/devices and POST /v1/devices/{id}/revoke hold their own auth_sessions
-- row FOR NO KEY UPDATE from their first statement to COMMIT (ownSessionWork,
-- ADR 0045 decision 3). Their later writes then need FOR KEY SHARE on users,
-- through the devices.user_id and audit_events.actor foreign keys. 0002's revoker
-- held users FOR UPDATE and then waited for that same session row, so a device
-- route racing a same-user sign-out deadlocked (40P01, ADR 0045 consequence 2).
--
-- FOR NO KEY UPDATE still conflicts with auth_create_session's FOR UPDATE (0002),
-- so a concurrent sign-in cannot escape a sign-out-all, and with another
-- revoker's FOR NO KEY UPDATE, so two revokers of one user still serialize. It
-- does not conflict with a foreign key's FOR KEY SHARE, which breaks the cycle.
--
-- 0002 is applied and stays as it is. The body below is 0002's, byte for byte,
-- except for that lock mode; the signature and parameter names are unchanged, so
-- this replaces the function instead of adding an overload.
CREATE OR REPLACE FUNCTION unai_private.auth_revoke_session(digest text, correlation uuid, all_sessions boolean) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE s public.auth_sessions;
BEGIN
 SELECT * INTO s FROM public.auth_sessions WHERE token_hash=digest AND revoked_at IS NULL AND expires_at>statement_timestamp();
 IF NOT FOUND THEN RETURN; END IF;
 -- Same per-user lock as issuance prevents a concurrent sign-out-all from missing an already issued session.
 PERFORM 1 FROM public.users WHERE id=s.user_id FOR NO KEY UPDATE;
 UPDATE public.auth_sessions SET revoked_at=now() WHERE user_id=s.user_id AND revoked_at IS NULL AND (all_sessions OR id=s.id);
 INSERT INTO public.audit_events(owner_scope_id,actor,purpose,objects_and_fields_accessed,policy_decision,model_or_code_version,result,correlation_id)
 VALUES(s.owner_scope_id,s.user_id,CASE WHEN all_sessions THEN 'auth.sign_out_all' ELSE 'auth.sign_out' END,
 jsonb_build_array(jsonb_build_object('type','users','id',s.user_id,'fields',jsonb_build_array())), 'ALLOW','0.1.0','SUCCESS',correlation);
END $$;
REVOKE ALL ON FUNCTION unai_private.auth_revoke_session(text,uuid,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION unai_private.auth_revoke_session(text,uuid,boolean) TO unai_auth;
