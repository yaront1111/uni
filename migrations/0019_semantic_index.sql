-- The semantic index (design entity `memory_embeddings`; PRD §23.2 step 10,
-- §33.13, FR-063) and the two reviewed readers deterministic selection and the
-- indexer need. ADR 0024 records the decisions below before the code.
--
-- Three rules are carried by the schema rather than by convention:
--
--  1. An embedding is an index, never support. It references the claim it
--     indexes and nothing references it; no belief, support row or projection
--     can name one.
--  2. The hard filters are columns. Owner, permission (the evidence's allowed
--     purposes), sensitivity (`security_scope`), time, source and entity are all
--     stored on the row, so a search filters on them *before* it ranks and never
--     has to compute a boundary after the nearest match was found (CRT-RD-04-A).
--  3. The row policy repeats the evidence gate for every read purpose. A row is
--     readable by the broker or the inspector only when the declared data purpose
--     is one its evidence admits and the declared ceiling is at or above its
--     security scope, so an unfiltered query under a lower ceiling or another
--     purpose reads nothing, whatever the application filter said.

CREATE TABLE memory_embeddings (
 id uuid PRIMARY KEY,
 owner_scope_id uuid NOT NULL REFERENCES owner_scopes(id),
 -- V0 indexes claims: a claim is the unit one source asserted, and it is what an
 -- unregistered surface predicate is stored as (PRD §17.5). A new object type is
 -- a new migration, with its own foreign key.
 object_type text NOT NULL CHECK(object_type IN ('claim')),
 object_id uuid NOT NULL,
 proposition_id uuid,
 frame_type_id text CHECK(frame_type_id IS NULL OR frame_type_id ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
 predicate_id text CHECK(predicate_id IS NULL OR predicate_id ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
 embedding_model text NOT NULL CHECK(embedding_model ~ '^[a-z][a-z0-9_.-]{0,63}$'),
 embedding_version text NOT NULL CHECK(embedding_version ~ '^[a-z][a-z0-9_.-]{0,63}$'),
 vector vector(256) NOT NULL,
 -- The sensitivity of the evidence behind the object; the ceiling a reader must
 -- declare to see the row at all.
 security_scope text NOT NULL CHECK(security_scope IN ('NORMAL','PRIVATE','RESTRICTED')),
 allowed_purposes text[] NOT NULL CHECK(cardinality(allowed_purposes) BETWEEN 1 AND 32),
 source_item_ids uuid[] NOT NULL CHECK(cardinality(source_item_ids) BETWEEN 1 AND 64),
 source_types text[] NOT NULL CHECK(cardinality(source_types) BETWEEN 1 AND 64),
 entity_ids uuid[] NOT NULL DEFAULT '{}' CHECK(cardinality(entity_ids) <= 64),
 -- The object's time span: its valid interval, or the time of its evidence when
 -- it declares none. A search that names a window excludes an object with no
 -- time at all, because it cannot be shown to be inside the window.
 time_start timestamptz,
 time_end timestamptz,
 -- When Uai learned the object, so a historical knowledge time sees only what
 -- was indexable then.
 recorded_at timestamptz NOT NULL,
 content_hash text NOT NULL CHECK(content_hash ~ '^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(owner_scope_id,id),
 -- Indexing the same content twice is one row; a changed text or a new model
 -- version is a new row beside the old one, never an overwrite.
 UNIQUE(owner_scope_id,object_type,object_id,embedding_version,content_hash),
 FOREIGN KEY(owner_scope_id,object_id) REFERENCES claims(owner_scope_id,id),
 FOREIGN KEY(owner_scope_id,proposition_id) REFERENCES propositions(owner_scope_id,id)
);
CREATE INDEX memory_embeddings_owner ON memory_embeddings(owner_scope_id,embedding_version,object_type);
CREATE INDEX memory_embeddings_object ON memory_embeddings(owner_scope_id,object_type,object_id);

ALTER TABLE memory_embeddings ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory_embeddings FORCE ROW LEVEL SECURITY;
-- The read purposes pass the evidence gate on every row. The governed write
-- purpose that writes the index is held to the same owner boundary but not to the
-- gate: it already reads the canonical memory an embedding is made from without
-- one, and `INSERT ... ON CONFLICT` checks this policy against the row it is
-- inserting, so gating it here would make a commit's success depend on the data
-- purpose the committer happened to declare.
CREATE POLICY owner_read ON memory_embeddings FOR SELECT TO unai_app
 USING(unai_private.has_owner_access(owner_scope_id)
 AND (unai_private.memory_purpose(ARRAY['memory.govern'])
   OR (unai_private.memory_purpose(ARRAY['memory.read','memory.inspect'])
     AND unai_private.evidence_access(allowed_purposes,security_scope))));
-- Written by the governed commit that created the claim, in the same
-- transaction, and by nothing a model or plugin holds.
CREATE POLICY owner_index ON memory_embeddings FOR INSERT TO unai_app
 WITH CHECK(unai_private.has_owner_access(owner_scope_id)
 AND unai_private.memory_purpose(ARRAY['memory.govern'])
 AND EXISTS(SELECT 1 FROM claims c WHERE c.owner_scope_id=memory_embeddings.owner_scope_id AND c.id=object_id));
GRANT SELECT,INSERT ON memory_embeddings TO unai_app;
CREATE TRIGGER memory_embeddings_immutable BEFORE UPDATE ON memory_embeddings
 FOR EACH ROW EXECUTE FUNCTION unai_private.canonicalization_record_immutable();

-- What the indexer may learn about the evidence behind a claim it indexes.
--
-- The indexer runs inside a governed commit, whose declared data purpose and
-- ceiling are the transaction's and not the index's: reading the anchor through
-- the row policies would make the security scope of an index row depend on who
-- committed. This function answers, for anchors of one owner, the item behind
-- each, its sensitivity, allowed purposes, source type and time -- no text, no
-- object key, no metadata. It re-checks live membership and the purpose itself.
CREATE FUNCTION unai_private.anchor_evidence_scope(owner uuid, anchors uuid[])
RETURNS TABLE(source_anchor_id uuid, source_item_id uuid, sensitivity text, allowed_purposes text[],
  source_type text, occurred_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT a.id, s.id, s.sensitivity, s.allowed_purposes, s.source_type, s.occurred_at
 FROM public.source_anchors a
 JOIN public.source_items s ON s.owner_scope_id=a.owner_scope_id AND s.id=a.source_item_id
 WHERE a.owner_scope_id=owner AND a.id=ANY(anchors) AND s.deleted_at IS NULL
   AND unai_private.has_owner_access(owner)
   AND current_setting('unai.purpose',true)='memory.govern'
$$;
REVOKE ALL ON FUNCTION unai_private.anchor_evidence_scope(uuid,uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION unai_private.anchor_evidence_scope(uuid,uuid[]) TO unai_app;

-- The broker selects current state, and a value under a contract the pinned
-- release does not hold may never be selected (PRD §17.5, CRT-REG-04-A). So the
-- model read purpose may ask the same one-boolean question the governor asks. The
-- function still returns no contract id, version, body or hash.
CREATE OR REPLACE FUNCTION unai_private.registry_contract_present(release_id uuid, contract text, kind text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT unai_private.owner_id() IS NOT NULL
  AND current_setting('unai.purpose',true) = ANY(ARRAY['memory.govern','memory.canonicalize','memory.inspect','memory.read'])
  AND EXISTS(SELECT 1 FROM public.registry_contracts c
    JOIN public.registry_releases r ON r.id=c.registry_release_id
    WHERE c.registry_release_id=release_id AND c.contract_id=contract
      AND c.contract_kind=kind AND r.lifecycle='RELEASED')
$$;
