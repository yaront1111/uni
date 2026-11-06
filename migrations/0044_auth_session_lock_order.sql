-- Lock all affected session rows in ascending id order before writing (ADR 0045 decision 5).
-- The removal route takes the same ordered lock set before its device trigger runs;
-- ordering only the revoker would leave the two-session deadlock intact.
CREATE OR REPLACE FUNCTION unai_private.auth_revoke_session(digest text, correlation uuid, all_sessions boolean) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE s public.auth_sessions;
BEGIN
 SELECT * INTO s FROM public.auth_sessions WHERE token_hash=digest AND revoked_at IS NULL AND expires_at>statement_timestamp();
 IF NOT FOUND THEN RETURN; END IF;
 -- Same per-user lock as issuance prevents a concurrent sign-out-all from missing an already issued session.
 PERFORM 1 FROM public.users WHERE id=s.user_id FOR NO KEY UPDATE;
 PERFORM 1 FROM public.auth_sessions WHERE user_id=s.user_id AND revoked_at IS NULL AND (all_sessions OR id=s.id) ORDER BY id FOR NO KEY UPDATE;
 UPDATE public.auth_sessions SET revoked_at=now() WHERE user_id=s.user_id AND revoked_at IS NULL AND (all_sessions OR id=s.id);
 INSERT INTO public.audit_events(owner_scope_id,actor,purpose,objects_and_fields_accessed,policy_decision,model_or_code_version,result,correlation_id)
 VALUES(s.owner_scope_id,s.user_id,CASE WHEN all_sessions THEN 'auth.sign_out_all' ELSE 'auth.sign_out' END,
 jsonb_build_array(jsonb_build_object('type','users','id',s.user_id,'fields',jsonb_build_array())), 'ALLOW','0.1.0','SUCCESS',correlation);
END $$;
REVOKE ALL ON FUNCTION unai_private.auth_revoke_session(text,uuid,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION unai_private.auth_revoke_session(text,uuid,boolean) TO unai_auth;

CREATE OR REPLACE FUNCTION unai_private.revoke_disabled_sessions() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF NEW.disabled_at IS NOT NULL THEN
  PERFORM 1 FROM public.auth_sessions WHERE user_id=NEW.id AND revoked_at IS NULL ORDER BY id FOR NO KEY UPDATE;
  UPDATE public.auth_sessions SET revoked_at=now() WHERE user_id=NEW.id AND revoked_at IS NULL;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION unai_private.revoke_disabled_sessions() FROM PUBLIC;
