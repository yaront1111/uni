-- Connector capabilities and the connector lifecycle (design entities
-- `connectors` and `connector_capability_grants`; PRD §27.1, §27.2, §27.5,
-- §33.2). ADR 0023 records the decisions below before the code.
--
-- Four invariants are carried by the schema rather than by application code:
--
--  1. A grant is one row per discrete manifest capability. The uniqueness is on
--     (owner scope, connector, capability id), so `gmail.read_metadata` and
--     `gmail.read_content` are two rows and granting one can never be read as
--     granting the other (CRT-CON-07-A).
--  2. V0 connectors are read-only. A capability whose access kind is WRITE may
--     exist in a manifest and be shown on the consent screen, but it may never be
--     recorded as granted: the CHECK refuses the row (CRT-CON-02-A/03-A/04-A).
--  3. Disconnect stops ingestion. A source item may only be written against a
--     connector whose status is ACTIVE, enforced by a trigger, so revocation
--     stops the flow even when a caller still holds a parsed page (CRT-CON-06-A).
--  4. A sync may move the cursor and may not mint authority. The connector's
--     identity columns never change, and `secret_ref` may only change under
--     `connector.manage`.

ALTER TABLE connectors
 ADD COLUMN secret_ref text CHECK(secret_ref IS NULL OR secret_ref ~ '^secret://[a-z0-9][a-z0-9_.-]{0,62}/[A-Za-z0-9][A-Za-z0-9_.:-]{0,190}(#[A-Za-z0-9][A-Za-z0-9_.-]{0,62})?$'),
 ADD COLUMN manifest_version text CHECK(manifest_version IS NULL OR manifest_version ~ '^[0-9]+\.[0-9]+\.[0-9]+$'),
 ADD COLUMN cursor_updated_at timestamptz,
 ADD COLUMN disconnected_at timestamptz,
 ADD COLUMN last_sync_error text CHECK(last_sync_error IS NULL OR last_sync_error ~ '^[A-Z][A-Z0-9_]{0,63}$'),
 ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
-- The lifecycle the Connected sources screen draws: awaiting consent, connected,
-- a named sync failure, a provider-side revocation that needs reauthorization,
-- and the owner's own disconnect. A revoked token is not a disconnect: the first
-- is the provider's answer, the second is the owner's instruction.
ALTER TABLE connectors ADD CONSTRAINT connectors_status
 CHECK(status IN ('PENDING_AUTHORIZATION','ACTIVE','SYNC_FAILED','TOKEN_REVOKED','DISCONNECTED'));
ALTER TABLE connectors ADD CONSTRAINT connectors_disconnected_state
 CHECK((status='DISCONNECTED')=(disconnected_at IS NOT NULL));
-- Disconnect destroys the secret reference, so a disconnected or revoked
-- connector cannot still name a credential to read with.
ALTER TABLE connectors ADD CONSTRAINT connectors_revoked_secret
 CHECK(status NOT IN ('DISCONNECTED','TOKEN_REVOKED') OR secret_ref IS NULL);

CREATE TABLE connector_capability_grants (
 id uuid PRIMARY KEY,
 owner_scope_id uuid NOT NULL REFERENCES owner_scopes(id),
 connector_id uuid NOT NULL,
 capability_id text NOT NULL CHECK(capability_id ~ '^[a-z][a-z0-9_]{0,31}\.[a-z][a-z0-9_]{0,63}$'),
 risk_class text NOT NULL CHECK(risk_class IN ('LOW','MEDIUM','HIGH')),
 access_kind text NOT NULL CHECK(access_kind IN ('READ','WRITE')),
 granted boolean NOT NULL,
 granted_at timestamptz,
 revoked_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(owner_scope_id,id),
 -- One row per discrete capability of one connector: the whole permission model.
 UNIQUE(owner_scope_id,connector_id,capability_id),
 FOREIGN KEY(owner_scope_id,connector_id) REFERENCES connectors(owner_scope_id,id),
 -- V0 excludes every external write but draft creation, which is not a connector
 -- scope: no write capability is ever recorded as granted here.
 CONSTRAINT connector_capability_grants_read_only CHECK(NOT(granted AND access_kind='WRITE')),
 -- Never granted, granted, or granted and since revoked. A revocation keeps the
 -- original grant time: what was permitted once stays visible in the record.
 CONSTRAINT connector_capability_grants_state CHECK(
  CASE WHEN granted THEN granted_at IS NOT NULL AND revoked_at IS NULL
  ELSE (granted_at IS NULL)=(revoked_at IS NULL) END)
);
CREATE INDEX connector_capability_grants_connector
 ON connector_capability_grants(owner_scope_id,connector_id,capability_id);

ALTER TABLE connector_capability_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE connector_capability_grants FORCE ROW LEVEL SECURITY;
-- The grant set is read by the consent screen, by every connector operation that
-- has to prove its capability, and by the least-context bundle builder, which
-- must know which capability an operation holds before it asks for memory
-- (PRD §27.3, CRT-SEC-03-A). None of those may write it.
CREATE POLICY owner_read ON connector_capability_grants FOR SELECT TO unai_app
 USING(unai_private.has_owner_access(owner_scope_id)
 AND current_setting('unai.purpose',true) IN ('connector.read','connector.manage','connector.sync','memory.read'));
CREATE POLICY owner_grant ON connector_capability_grants FOR INSERT TO unai_app
 WITH CHECK(unai_private.has_owner_access(owner_scope_id)
 AND current_setting('unai.purpose',true)='connector.manage'
 AND EXISTS(SELECT 1 FROM connectors c WHERE c.owner_scope_id=connector_capability_grants.owner_scope_id AND c.id=connector_id));
CREATE POLICY owner_regrant ON connector_capability_grants FOR UPDATE TO unai_app
 USING(unai_private.has_owner_access(owner_scope_id) AND current_setting('unai.purpose',true)='connector.manage')
 WITH CHECK(unai_private.has_owner_access(owner_scope_id) AND current_setting('unai.purpose',true)='connector.manage');
GRANT SELECT,INSERT,UPDATE ON connector_capability_grants TO unai_app;

-- A grant row keeps its identity: a toggle moves `granted`, `granted_at` and
-- `revoked_at` and nothing else, so a denied capability can never become a
-- granted one by being renamed or reclassified.
CREATE FUNCTION unai_private.connector_grant_identity() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
 BEGIN
  IF NEW.id<>OLD.id OR NEW.owner_scope_id<>OLD.owner_scope_id OR NEW.connector_id<>OLD.connector_id
   OR NEW.capability_id<>OLD.capability_id OR NEW.access_kind<>OLD.access_kind OR NEW.risk_class<>OLD.risk_class
   OR NEW.created_at<>OLD.created_at THEN
   RAISE EXCEPTION 'CONNECTOR_GRANT_IDENTITY_IMMUTABLE' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
 END
$$;
REVOKE ALL ON FUNCTION unai_private.connector_grant_identity() FROM PUBLIC;
CREATE TRIGGER connector_grant_identity BEFORE UPDATE ON connector_capability_grants
 FOR EACH ROW EXECUTE FUNCTION unai_private.connector_grant_identity();

-- Connector provisioning and lifecycle. The delivered SELECT policy is
-- untouched; these are the write paths the Connected sources and Grant connector
-- capabilities screens need, each gated on its own purpose.
CREATE POLICY owner_connect ON connectors FOR INSERT TO unai_app
 WITH CHECK(unai_private.has_owner_access(owner_scope_id)
 AND current_setting('unai.purpose',true)='connector.manage');
-- `connector.sync` may move the cursor and record a failure; `connector.manage`
-- may change consent state and disconnect. The trigger below decides which
-- columns each of them may actually move.
CREATE POLICY owner_lifecycle ON connectors FOR UPDATE TO unai_app
 USING(unai_private.has_owner_access(owner_scope_id)
 AND current_setting('unai.purpose',true) IN ('connector.manage','connector.sync'))
 WITH CHECK(unai_private.has_owner_access(owner_scope_id)
 AND current_setting('unai.purpose',true) IN ('connector.manage','connector.sync'));
GRANT INSERT,UPDATE ON connectors TO unai_app;

CREATE FUNCTION unai_private.connector_update_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
 BEGIN
  IF NEW.id<>OLD.id OR NEW.owner_scope_id<>OLD.owner_scope_id OR NEW.connector_type<>OLD.connector_type
   OR NEW.external_account_ref<>OLD.external_account_ref OR NEW.created_at<>OLD.created_at THEN
   RAISE EXCEPTION 'CONNECTOR_IDENTITY_IMMUTABLE' USING ERRCODE='55000';
  END IF;
  -- A sync reads with the authority the owner already granted; it never changes
  -- what that authority is. Only the consent path may touch the credential
  -- handle, the manifest or the permission manifest itself.
  IF current_setting('unai.purpose',true)='connector.sync'
   AND (NEW.secret_ref IS DISTINCT FROM OLD.secret_ref
    OR NEW.permission_manifest<>OLD.permission_manifest
    OR NEW.manifest_version IS DISTINCT FROM OLD.manifest_version
    OR NEW.disconnected_at IS DISTINCT FROM OLD.disconnected_at) THEN
   RAISE EXCEPTION 'CONNECTOR_SYNC_MAY_NOT_CHANGE_AUTHORITY' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
 END
$$;
REVOKE ALL ON FUNCTION unai_private.connector_update_guard() FROM PUBLIC;
CREATE TRIGGER connector_update_guard BEFORE UPDATE ON connectors
 FOR EACH ROW EXECUTE FUNCTION unai_private.connector_update_guard();

-- Disconnect stops ingestion, in the schema and not only in the service: an
-- evidence row naming a connector that is not ACTIVE is refused, whoever writes
-- it and whatever page they are holding (CRT-CON-06-A).
CREATE FUNCTION unai_private.connector_ingestion_active() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
 DECLARE connector_status text;
 BEGIN
  IF NEW.connector_id IS NULL THEN RETURN NEW; END IF;
  SELECT status INTO connector_status FROM public.connectors
   WHERE id=NEW.connector_id AND owner_scope_id=NEW.owner_scope_id;
  IF connector_status IS DISTINCT FROM 'ACTIVE' THEN
   RAISE EXCEPTION 'CONNECTOR_INGESTION_STOPPED' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
 END
$$;
REVOKE ALL ON FUNCTION unai_private.connector_ingestion_active() FROM PUBLIC;
CREATE TRIGGER connector_ingestion_active BEFORE INSERT ON source_items
 FOR EACH ROW EXECUTE FUNCTION unai_private.connector_ingestion_active();

-- The connector sync is an ingestion path, so it joins the purposes evidence
-- admits, exactly as 0011, 0012, 0014 and 0017 each joined their own. The data
-- purpose and the sensitivity ceiling still decide what it may store and read.
CREATE OR REPLACE FUNCTION unai_private.evidence_access(purposes text[], sensitivity text) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT current_setting('unai.purpose',true) IN ('evidence.ingest','evidence.read','connector.read','connector.sync','memory.extract','memory.canonicalize','memory.govern','memory.correct','memory.read','memory.inspect')
 AND current_setting('unai.data_purpose',true)=ANY(purposes)
 AND array_position(ARRAY['NORMAL','PRIVATE','RESTRICTED'],sensitivity)
 <= array_position(ARRAY['NORMAL','PRIVATE','RESTRICTED'],current_setting('unai.maximum_sensitivity',true))
$$;
-- The three evidence write paths a sync uses. Each carries the same owner
-- access, writer binding and existing-source-item conditions the delivered
-- `evidence.ingest` policies carry; none of them widens what may be read.
CREATE POLICY evidence_append_sync ON source_items FOR INSERT TO unai_app
 WITH CHECK(unai_private.has_owner_access(owner_scope_id) AND submitted_by_user_id=unai_private.actor_id()
 AND current_setting('unai.purpose',true)='connector.sync' AND unai_private.evidence_access(allowed_purposes,sensitivity));
CREATE POLICY anchor_append_sync ON source_anchors FOR INSERT TO unai_app
 WITH CHECK(unai_private.has_owner_access(owner_scope_id)
 AND current_setting('unai.purpose',true)='connector.sync'
 AND EXISTS(SELECT 1 FROM source_items s WHERE s.owner_scope_id=source_anchors.owner_scope_id AND s.id=source_item_id));
CREATE POLICY object_key_append_sync ON evidence_object_keys FOR INSERT TO unai_app
 WITH CHECK(unai_private.has_owner_access(owner_scope_id)
 AND current_setting('unai.purpose',true)='connector.sync'
 AND EXISTS(SELECT 1 FROM source_items s WHERE s.owner_scope_id=evidence_object_keys.owner_scope_id AND s.id=source_item_id));
-- Every ingested item has a recorded route, including one a sync ingested.
CREATE POLICY owner_append_sync ON triage_decisions FOR INSERT TO unai_app
 WITH CHECK(unai_private.has_owner_access(owner_scope_id)
 AND unai_private.extraction_purpose(ARRAY['connector.sync'])
 AND EXISTS(SELECT 1 FROM source_items s WHERE s.owner_scope_id=triage_decisions.owner_scope_id AND s.id=source_item_id));
CREATE POLICY owner_read_sync ON triage_decisions FOR SELECT TO unai_app
 USING(unai_private.has_owner_access(owner_scope_id)
 AND unai_private.extraction_purpose(ARRAY['connector.sync'])
 AND EXISTS(SELECT 1 FROM source_items s WHERE s.owner_scope_id=triage_decisions.owner_scope_id AND s.id=source_item_id));
-- The retry receipt an idempotent ingest writes, under the sync's purpose too.
-- The delivered `receipt_read` policy gates on owner access and the evidence
-- row alone, so no read policy changes here.
CREATE POLICY owner_append_sync ON evidence_ingestion_receipts FOR INSERT TO unai_app
 WITH CHECK(unai_private.has_owner_access(owner_scope_id)
 AND current_setting('unai.purpose',true)='connector.sync'
 AND EXISTS(SELECT 1 FROM source_items s WHERE s.owner_scope_id=evidence_ingestion_receipts.owner_scope_id AND s.id=source_item_id));
