CREATE ROLE unai_auth NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
GRANT USAGE ON SCHEMA unai_private TO unai_auth;
ALTER TABLE users ADD COLUMN auth_email text;
ALTER TABLE devices ADD COLUMN removed_at timestamptz;
ALTER TABLE devices ADD CONSTRAINT device_actor_identity UNIQUE(owner_scope_id,user_id,id);

CREATE TABLE auth_identities (
  owner_scope_id uuid NOT NULL,
  user_id uuid NOT NULL,
  issuer text NOT NULL CHECK(issuer='https://accounts.google.com'),
  subject text NOT NULL CHECK(length(subject) BETWEEN 1 AND 255),
  PRIMARY KEY(issuer,subject),
  FOREIGN KEY(owner_scope_id,user_id) REFERENCES owner_scope_members(owner_scope_id,user_id)
);
CREATE TABLE auth_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_scope_id uuid NOT NULL,
  user_id uuid NOT NULL,
  token_hash text NOT NULL UNIQUE CHECK(token_hash ~ '^[a-f0-9]{64}$'),
  device_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL CHECK(expires_at<=created_at+interval '7 days'),
  revoked_at timestamptz,
  FOREIGN KEY(owner_scope_id,user_id) REFERENCES owner_scope_members(owner_scope_id,user_id),
  FOREIGN KEY(owner_scope_id,user_id,device_id) REFERENCES devices(owner_scope_id,user_id,id)
);
CREATE INDEX auth_sessions_user ON auth_sessions(user_id) WHERE revoked_at IS NULL;
CREATE INDEX auth_sessions_device ON auth_sessions(device_id) WHERE revoked_at IS NULL;
ALTER TABLE auth_identities ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_identities FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_isolation ON auth_identities TO unai_app
 USING(unai_private.has_owner_access(owner_scope_id) AND user_id=unai_private.actor_id());
ALTER TABLE auth_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_isolation ON auth_sessions TO unai_app
 USING(unai_private.has_owner_access(owner_scope_id) AND user_id=unai_private.actor_id())
 WITH CHECK(unai_private.has_owner_access(owner_scope_id) AND user_id=unai_private.actor_id());
GRANT SELECT(owner_scope_id,user_id,issuer,subject) ON auth_identities TO unai_app;
GRANT SELECT(id,owner_scope_id,user_id,device_id,created_at,expires_at,revoked_at) ON auth_sessions TO unai_app;
GRANT UPDATE(device_id,revoked_at) ON auth_sessions TO unai_app;

CREATE FUNCTION unai_private.auth_user(requested uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('id',u.id,'name',u.display_name,'email',u.auth_email,
 'emailVerified',NULL,'ownerScopeId',o.id) FROM public.users u
 JOIN public.owner_scopes o ON o.created_by_user_id=u.id AND o.scope_kind='PERSONAL' AND o.deleted_at IS NULL
 JOIN public.owner_scope_members m ON m.owner_scope_id=o.id AND m.user_id=u.id
 WHERE u.id=requested AND u.disabled_at IS NULL AND m.valid_from<=statement_timestamp()
 AND (m.valid_to IS NULL OR m.valid_to>statement_timestamp()) ORDER BY o.created_at,o.id LIMIT 1
$$;
CREATE FUNCTION unai_private.auth_create_user(requested uuid, display text, email text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE owner_id uuid:=gen_random_uuid();
BEGIN
 INSERT INTO public.users(id,display_name,auth_email) VALUES(requested,left(coalesce(nullif(display,''),'Uai user'),120),email);
 INSERT INTO public.owner_scopes(id,scope_kind,display_name,created_by_user_id) VALUES(owner_id,'PERSONAL','Personal',requested);
 INSERT INTO public.owner_scope_members(owner_scope_id,user_id,role) VALUES(owner_id,requested,'OWNER');
 RETURN unai_private.auth_user(requested);
END $$;
CREATE FUNCTION unai_private.auth_link_identity(requested uuid, sub text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE owner_id uuid;
BEGIN
 SELECT (unai_private.auth_user(requested)->>'ownerScopeId')::uuid INTO owner_id;
 IF owner_id IS NULL THEN RAISE EXCEPTION 'AUTH_REFUSED'; END IF;
 INSERT INTO public.auth_identities(owner_scope_id,user_id,issuer,subject)
 VALUES(owner_id,requested,'https://accounts.google.com',sub);
END $$;
CREATE FUNCTION unai_private.auth_identity(sub text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT unai_private.auth_user(user_id) FROM public.auth_identities
 WHERE issuer='https://accounts.google.com' AND subject=sub
$$;
CREATE FUNCTION unai_private.auth_session(digest text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('id',s.id,'userId',s.user_id,'ownerScopeId',s.owner_scope_id,
 'deviceId',s.device_id,'expires',s.expires_at,'user',unai_private.auth_user(s.user_id))
 FROM public.auth_sessions s JOIN public.users u ON u.id=s.user_id
 JOIN public.owner_scope_members m ON m.user_id=s.user_id AND m.owner_scope_id=s.owner_scope_id
 JOIN public.owner_scopes o ON o.id=s.owner_scope_id
 WHERE s.token_hash=digest AND s.revoked_at IS NULL AND s.expires_at>statement_timestamp()
 AND u.disabled_at IS NULL AND o.deleted_at IS NULL AND m.valid_from<=statement_timestamp()
 AND (m.valid_to IS NULL OR m.valid_to>statement_timestamp())
 AND (s.device_id IS NULL OR EXISTS(SELECT 1 FROM public.devices d WHERE d.id=s.device_id AND d.removed_at IS NULL))
$$;
CREATE FUNCTION unai_private.auth_create_session(digest text, requested uuid, expiry timestamptz, correlation uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE owner_id uuid; session_id uuid;
BEGIN
 PERFORM 1 FROM public.users WHERE id=requested AND disabled_at IS NULL FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'AUTH_REFUSED'; END IF;
 SELECT (unai_private.auth_user(requested)->>'ownerScopeId')::uuid INTO owner_id;
 IF owner_id IS NULL THEN RAISE EXCEPTION 'AUTH_REFUSED'; END IF;
 INSERT INTO public.auth_sessions(owner_scope_id,user_id,token_hash,expires_at)
 VALUES(owner_id,requested,digest,least(expiry,now()+interval '7 days')) RETURNING id INTO session_id;
 INSERT INTO public.audit_events(owner_scope_id,actor,purpose,objects_and_fields_accessed,policy_decision,model_or_code_version,result,correlation_id)
 VALUES(owner_id,requested,'auth.sign_in',jsonb_build_array(jsonb_build_object('type','auth_sessions','id',session_id,'fields',jsonb_build_array('created_at'))),'ALLOW','0.1.0','SUCCESS',correlation);
 RETURN unai_private.auth_session(digest);
END $$;
CREATE FUNCTION unai_private.auth_revoke_session(digest text, correlation uuid, all_sessions boolean) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE s public.auth_sessions;
BEGIN
 SELECT * INTO s FROM public.auth_sessions WHERE token_hash=digest AND revoked_at IS NULL AND expires_at>statement_timestamp();
 IF NOT FOUND THEN RETURN; END IF;
 -- Same per-user lock as issuance prevents a concurrent sign-out-all from missing an already issued session.
 PERFORM 1 FROM public.users WHERE id=s.user_id FOR UPDATE;
 UPDATE public.auth_sessions SET revoked_at=now() WHERE user_id=s.user_id AND revoked_at IS NULL AND (all_sessions OR id=s.id);
 INSERT INTO public.audit_events(owner_scope_id,actor,purpose,objects_and_fields_accessed,policy_decision,model_or_code_version,result,correlation_id)
 VALUES(s.owner_scope_id,s.user_id,CASE WHEN all_sessions THEN 'auth.sign_out_all' ELSE 'auth.sign_out' END,
 jsonb_build_array(jsonb_build_object('type','users','id',s.user_id,'fields',jsonb_build_array())), 'ALLOW','0.1.0','SUCCESS',correlation);
END $$;
CREATE FUNCTION unai_private.revoke_disabled_sessions() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF NEW.disabled_at IS NOT NULL THEN UPDATE public.auth_sessions SET revoked_at=now() WHERE user_id=NEW.id AND revoked_at IS NULL; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER revoke_disabled_sessions AFTER UPDATE OF disabled_at ON users FOR EACH ROW EXECUTE FUNCTION unai_private.revoke_disabled_sessions();
CREATE FUNCTION unai_private.revoke_removed_device_sessions() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF NEW.removed_at IS NOT NULL THEN UPDATE public.auth_sessions SET revoked_at=now() WHERE device_id=NEW.id AND revoked_at IS NULL; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER revoke_removed_device_sessions AFTER UPDATE OF removed_at ON devices FOR EACH ROW EXECUTE FUNCTION unai_private.revoke_removed_device_sessions();
REVOKE ALL ON FUNCTION unai_private.auth_user(uuid),unai_private.auth_create_user(uuid,text,text),
 unai_private.auth_link_identity(uuid,text),unai_private.auth_identity(text),unai_private.auth_session(text),
 unai_private.auth_create_session(text,uuid,timestamptz,uuid),unai_private.auth_revoke_session(text,uuid,boolean),
 unai_private.revoke_disabled_sessions(),unai_private.revoke_removed_device_sessions() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION unai_private.auth_user(uuid),unai_private.auth_create_user(uuid,text,text),
 unai_private.auth_link_identity(uuid,text),unai_private.auth_identity(text),unai_private.auth_session(text),
 unai_private.auth_create_session(text,uuid,timestamptz,uuid),unai_private.auth_revoke_session(text,uuid,boolean) TO unai_auth;
