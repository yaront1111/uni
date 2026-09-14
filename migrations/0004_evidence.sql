CREATE TABLE connectors (
 id uuid PRIMARY KEY,
 owner_scope_id uuid NOT NULL REFERENCES owner_scopes(id),
 connector_type text NOT NULL CHECK(length(connector_type) BETWEEN 1 AND 64),
 external_account_ref text NOT NULL CHECK(length(external_account_ref) BETWEEN 1 AND 512),
 permission_manifest jsonb NOT NULL CHECK(jsonb_typeof(permission_manifest)='object'),
 status text NOT NULL CHECK(length(status) BETWEEN 1 AND 64),
 created_at timestamptz NOT NULL DEFAULT now(),
 last_cursor jsonb,
 UNIQUE(owner_scope_id,id),
 UNIQUE(owner_scope_id,connector_type,external_account_ref)
);
CREATE TABLE source_items (
 id uuid PRIMARY KEY,
 owner_scope_id uuid NOT NULL REFERENCES owner_scopes(id),
 connector_id uuid,
 source_type text NOT NULL CHECK(source_type ~ '^[A-Z][A-Z0-9_]{0,63}$'),
 external_id text NOT NULL CHECK(length(external_id) BETWEEN 1 AND 512),
 parent_external_id text CHECK(length(parent_external_id) BETWEEN 1 AND 512),
 actor_entity_id uuid CHECK(actor_entity_id IS NULL),
 actor_ref jsonb NOT NULL CHECK(jsonb_typeof(actor_ref)='object'),
 submitted_by_user_id uuid NOT NULL,
 occurred_at timestamptz,
 observed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 raw_object_id uuid NOT NULL UNIQUE,
 raw_object_ref text NOT NULL UNIQUE CHECK(length(raw_object_ref) BETWEEN 1 AND 1024),
 content_hash text NOT NULL CHECK(content_hash ~ '^[a-f0-9]{64}$'),
 deterministic_metadata jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(deterministic_metadata)='object'),
 sensitivity text NOT NULL CHECK(sensitivity IN ('NORMAL','PRIVATE','RESTRICTED')),
 allowed_purposes text[] NOT NULL CHECK(cardinality(allowed_purposes)>0 AND array_position(allowed_purposes,NULL) IS NULL),
 ingestion_version text NOT NULL CHECK(ingestion_version='evidence-json-v1'),
 idempotency_key text NOT NULL,
 deleted_at timestamptz,
 UNIQUE(owner_scope_id,id),
 UNIQUE(owner_scope_id,idempotency_key),
 CONSTRAINT source_items_identity UNIQUE NULLS NOT DISTINCT(owner_scope_id,connector_id,source_type,external_id,content_hash),
 FOREIGN KEY(owner_scope_id,connector_id) REFERENCES connectors(owner_scope_id,id),
 FOREIGN KEY(owner_scope_id,submitted_by_user_id) REFERENCES owner_scope_members(owner_scope_id,user_id)
);
CREATE INDEX source_items_connector ON source_items(owner_scope_id,connector_id,observed_at,id);
CREATE TABLE source_anchors (
 id uuid PRIMARY KEY,
 owner_scope_id uuid NOT NULL REFERENCES owner_scopes(id),
 source_item_id uuid NOT NULL,
 anchor_kind text NOT NULL CHECK(length(anchor_kind) BETWEEN 1 AND 64),
 anchor jsonb NOT NULL CHECK(jsonb_typeof(anchor)='object'),
 normalized_text text,
 created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(owner_scope_id,source_item_id) REFERENCES source_items(owner_scope_id,id)
);
CREATE INDEX source_anchors_source ON source_anchors(owner_scope_id,source_item_id);

CREATE FUNCTION unai_private.evidence_access(purposes text[], sensitivity text) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT current_setting('unai.purpose',true) IN ('evidence.ingest','evidence.read','connector.read')
 AND current_setting('unai.data_purpose',true)=ANY(purposes)
 AND array_position(ARRAY['NORMAL','PRIVATE','RESTRICTED'],sensitivity)
 <= array_position(ARRAY['NORMAL','PRIVATE','RESTRICTED'],current_setting('unai.maximum_sensitivity',true))
$$;
REVOKE ALL ON FUNCTION unai_private.evidence_access(text[],text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION unai_private.evidence_access(text[],text) TO unai_app;

ALTER TABLE connectors ENABLE ROW LEVEL SECURITY;
ALTER TABLE connectors FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_read ON connectors FOR SELECT TO unai_app USING(unai_private.has_owner_access(owner_scope_id));
ALTER TABLE source_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE source_items FORCE ROW LEVEL SECURITY;
CREATE POLICY evidence_read ON source_items FOR SELECT TO unai_app
 USING(unai_private.has_owner_access(owner_scope_id) AND deleted_at IS NULL AND unai_private.evidence_access(allowed_purposes,sensitivity));
CREATE POLICY evidence_append ON source_items FOR INSERT TO unai_app
 WITH CHECK(unai_private.has_owner_access(owner_scope_id) AND submitted_by_user_id=unai_private.actor_id()
 AND current_setting('unai.purpose',true)='evidence.ingest' AND unai_private.evidence_access(allowed_purposes,sensitivity));
ALTER TABLE source_anchors ENABLE ROW LEVEL SECURITY;
ALTER TABLE source_anchors FORCE ROW LEVEL SECURITY;
CREATE POLICY anchor_read ON source_anchors FOR SELECT TO unai_app
 USING(unai_private.has_owner_access(owner_scope_id) AND EXISTS(SELECT 1 FROM source_items s WHERE s.id=source_item_id AND s.owner_scope_id=source_anchors.owner_scope_id));
GRANT SELECT ON connectors,source_items,source_anchors TO unai_app;
GRANT INSERT ON source_items TO unai_app;

CREATE FUNCTION unai_private.immutable_evidence() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
 BEGIN RAISE EXCEPTION 'EVIDENCE_IMMUTABLE' USING ERRCODE='55000'; END
$$;
REVOKE ALL ON FUNCTION unai_private.immutable_evidence() FROM PUBLIC;
CREATE TRIGGER immutable_evidence BEFORE UPDATE ON source_items FOR EACH ROW EXECUTE FUNCTION unai_private.immutable_evidence();
CREATE TRIGGER immutable_anchor BEFORE UPDATE ON source_anchors FOR EACH ROW EXECUTE FUNCTION unai_private.immutable_evidence();
