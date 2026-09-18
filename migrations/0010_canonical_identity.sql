-- Canonical identity storage: entities and their aliases and lineage, frame
-- instances and roles, belief slots, propositions, claims and the two versioned
-- fingerprint indexes (design entities `entities`, `entity_aliases`,
-- `entity_lineage`, `frame_instances`, `frame_instance_roles`, `belief_slots`,
-- `slot_fingerprints`, `propositions`, `proposition_fingerprints`, `claims`;
-- PRD §33.4/§33.6, §13).
--
-- Three invariants are carried by the schema itself rather than by convention:
--
--  1. Identity is surrogate (PRD §13.1). Every row below takes a UUIDv7 the
--     application mints from no content at all. Nothing here derives an id from
--     a hash, and no fingerprint column is a primary or unique key.
--  2. A fingerprint is a lookup index (PRD §13.2). The fingerprint tables are
--     deliberately non-unique: one fingerprint may name several slots, and a
--     candidate list is the whole answer a lookup may give. Identity follows
--     only from semantic comparison, which is application work.
--  3. A belief slot excludes the candidate value (PRD §11.8). `belief_slots` has
--     no value column; the value lives on `propositions`, so "ILS 50" and
--     "ILS 60" are two propositions in one slot rather than one overwritten row.

-- Anything with an identity in memory (PRD §11.3). Entity resolution is
-- probabilistic and the default is under-merge: two people who share a name stay
-- two rows until sufficient evidence or a user merge says otherwise, which is why
-- no uniqueness constraint anywhere keys an entity by its label or alias.
CREATE TABLE entities (
 id uuid PRIMARY KEY,
 owner_scope_id uuid NOT NULL REFERENCES owner_scopes(id),
 entity_kind text NOT NULL CHECK(entity_kind IN ('PERSON','ORGANIZATION','PROJECT','ACCOUNT','DOCUMENT','PLACE','TRANSACTION','DECISION','EVENT','TOPIC')),
 canonical_label text CHECK(length(canonical_label) BETWEEN 1 AND 512),
 lifecycle text NOT NULL DEFAULT 'ACTIVE' CHECK(lifecycle IN ('ACTIVE','MERGED','SPLIT','RETIRED')),
 created_at timestamptz NOT NULL DEFAULT now(),
 retired_at timestamptz,
 UNIQUE(owner_scope_id,id),
 CONSTRAINT entities_retirement_recorded CHECK((lifecycle='ACTIVE')=(retired_at IS NULL))
);
CREATE INDEX entities_owner ON entities(owner_scope_id,entity_kind,lifecycle);

-- Surface forms that point at an entity. `normalized_value` is the candidate
-- lookup key and is intentionally non-unique: a shared name is a candidate, not
-- an identity. Alias strength is carried by `alias_type`, so the entity service
-- can treat an exact mailbox or external identifier as sufficient evidence while
-- a display name alone stays a possible match.
CREATE TABLE entity_aliases (
 id uuid PRIMARY KEY,
 owner_scope_id uuid NOT NULL REFERENCES owner_scopes(id),
 entity_id uuid NOT NULL,
 alias_type text NOT NULL CHECK(alias_type IN ('DISPLAY_NAME','GIVEN_NAME','FULL_NAME','NICKNAME','EMAIL','HANDLE','PHONE','EXTERNAL_ID')),
 alias_value text NOT NULL CHECK(length(alias_value) BETWEEN 1 AND 512),
 normalized_value text NOT NULL CHECK(length(normalized_value) BETWEEN 1 AND 512),
 source_item_id uuid,
 confidence numeric CHECK(confidence >= 0 AND confidence <= 1),
 valid_from timestamptz,
 valid_to timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(owner_scope_id,id),
 FOREIGN KEY(owner_scope_id,entity_id) REFERENCES entities(owner_scope_id,id),
 FOREIGN KEY(owner_scope_id,source_item_id) REFERENCES source_items(owner_scope_id,id),
 CONSTRAINT entity_aliases_interval CHECK(valid_to IS NULL OR valid_from IS NULL OR valid_from <= valid_to)
);
CREATE INDEX entity_aliases_candidate ON entity_aliases(owner_scope_id,normalized_value,alias_type);
CREATE INDEX entity_aliases_entity ON entity_aliases(owner_scope_id,entity_id);

-- Every old entity id stays resolvable after a merge or split and is never
-- repurposed (PRD §44.13, invariant "old surrogate IDs remain resolvable").
-- transaction_id names the belief transaction that recorded the change; until the
-- belief-transaction node delivers that table the column is constrained null
-- rather than left as a dangling reference, and that node's migration replaces
-- the check with its foreign key.
CREATE TABLE entity_lineage (
 id uuid PRIMARY KEY,
 owner_scope_id uuid NOT NULL REFERENCES owner_scopes(id),
 from_entity_id uuid NOT NULL,
 to_entity_id uuid NOT NULL,
 lineage_kind text NOT NULL CHECK(lineage_kind IN ('MERGED_INTO','SPLIT_INTO','ALIAS_OF','RETIRED_PARENT')),
 transaction_id uuid CHECK(transaction_id IS NULL),
 reason jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(reason)='object'),
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(owner_scope_id,id),
 FOREIGN KEY(owner_scope_id,from_entity_id) REFERENCES entities(owner_scope_id,id),
 FOREIGN KEY(owner_scope_id,to_entity_id) REFERENCES entities(owner_scope_id,id),
 CONSTRAINT entity_lineage_distinct CHECK(from_entity_id <> to_entity_id)
);
CREATE INDEX entity_lineage_from ON entity_lineage(owner_scope_id,from_entity_id,lineage_kind);
CREATE INDEX entity_lineage_to ON entity_lineage(owner_scope_id,to_entity_id,lineage_kind);

-- One particular real-world situation of a registry frame type. Participants
-- never define instance identity on their own (PRD §11.5), so there is no
-- uniqueness constraint over roles: "another ILS 50 from Daniel" is a second
-- instance, not a conflicting write to the first.
CREATE TABLE frame_instances (
 id uuid PRIMARY KEY,
 owner_scope_id uuid NOT NULL REFERENCES owner_scopes(id),
 frame_type_id text NOT NULL CHECK(frame_type_id ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
 context_space_id uuid NOT NULL,
 lifecycle text NOT NULL DEFAULT 'ACTIVE' CHECK(lifecycle IN ('ACTIVE','MERGED','SPLIT','RETIRED')),
 created_by_transaction_id uuid CHECK(created_by_transaction_id IS NULL),
 created_at timestamptz NOT NULL DEFAULT now(),
 retired_at timestamptz,
 UNIQUE(owner_scope_id,id),
 FOREIGN KEY(owner_scope_id,context_space_id) REFERENCES context_spaces(owner_scope_id,id),
 CONSTRAINT frame_instances_retirement_recorded CHECK((lifecycle='ACTIVE')=(retired_at IS NULL))
);
CREATE INDEX frame_instances_owner ON frame_instances(owner_scope_id,frame_type_id,lifecycle);

-- A governed location where compatible values can agree, conflict, correct or
-- supersede one another (PRD §11.8). The descriptor is exactly frame instance,
-- predicate, context space, modality and qualifiers -- and nothing else. There is
-- deliberately no unique index over that tuple: PRD §13.5 requires a collision to
-- trigger semantic comparison rather than to establish identity by itself.
CREATE TABLE belief_slots (
 id uuid PRIMARY KEY,
 owner_scope_id uuid NOT NULL REFERENCES owner_scopes(id),
 frame_instance_id uuid NOT NULL,
 predicate_id text NOT NULL CHECK(predicate_id ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
 context_space_id uuid NOT NULL,
 modality text NOT NULL CHECK(modality IN ('ACTUAL','SCHEDULED','INTENDED','COMMITTED','EXPECTED','PREDICTED','RECOMMENDED','CONDITIONAL')),
 qualifiers jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(qualifiers)='object'),
 lifecycle text NOT NULL DEFAULT 'ACTIVE' CHECK(lifecycle IN ('ACTIVE','MERGED','RETIRED')),
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(owner_scope_id,id),
 FOREIGN KEY(owner_scope_id,frame_instance_id) REFERENCES frame_instances(owner_scope_id,id),
 FOREIGN KEY(owner_scope_id,context_space_id) REFERENCES context_spaces(owner_scope_id,id)
);
CREATE INDEX belief_slots_instance ON belief_slots(owner_scope_id,frame_instance_id,predicate_id);

-- One exact normalized candidate value inside a slot (PRD §11.9). Two amounts for
-- the same obligation are two rows here, never one overwritten row.
CREATE TABLE propositions (
 id uuid PRIMARY KEY,
 owner_scope_id uuid NOT NULL REFERENCES owner_scopes(id),
 belief_slot_id uuid NOT NULL,
 normalized_value jsonb NOT NULL,
 polarity text NOT NULL DEFAULT 'POSITIVE' CHECK(polarity IN ('POSITIVE','NEGATIVE')),
 lifecycle text NOT NULL DEFAULT 'ACTIVE' CHECK(lifecycle IN ('ACTIVE','MERGED','RETIRED')),
 created_at timestamptz NOT NULL DEFAULT now(),
 retired_at timestamptz,
 UNIQUE(owner_scope_id,id),
 FOREIGN KEY(owner_scope_id,belief_slot_id) REFERENCES belief_slots(owner_scope_id,id),
 CONSTRAINT propositions_retirement_recorded CHECK((lifecycle='ACTIVE')=(retired_at IS NULL))
);
CREATE INDEX propositions_slot ON propositions(owner_scope_id,belief_slot_id,lifecycle);

-- Versioned lookup indexes. A fingerprint row is a recorded-time interval over
-- one (release, normalization version) pair, so recomputing under a new
-- normalization version closes the old row and appends a new one while the slot
-- and proposition ids never move (CRT-MEM-04-A). `fingerprint` carries no unique
-- constraint on purpose: a lookup that matches two slots must return both
-- candidates (CRT-MEM-04-B).
--
-- registry_release_id records the pinned release the descriptor was normalized
-- under, and is null where the deployment has not materialized a release snapshot
-- yet. It carries no foreign key on purpose: registry_releases is the global
-- immutable snapshot of ADR 0011, whose own migration owns its referential
-- surface and whose truncation guard a reference from here would preempt.
-- normalization_version, which is what actually versions this index, is always
-- present and always constrained.
CREATE TABLE slot_fingerprints (
 id uuid PRIMARY KEY,
 owner_scope_id uuid NOT NULL REFERENCES owner_scopes(id),
 belief_slot_id uuid NOT NULL,
 registry_release_id uuid,
 normalization_version text NOT NULL CHECK(normalization_version ~ '^[a-z][a-z0-9_.-]{0,63}$'),
 fingerprint text NOT NULL CHECK(fingerprint ~ '^[a-f0-9]{64}$'),
 descriptor jsonb NOT NULL CHECK(jsonb_typeof(descriptor)='object'),
 valid_from_recorded_at timestamptz NOT NULL DEFAULT now(),
 valid_to_recorded_at timestamptz,
 UNIQUE(owner_scope_id,id),
 FOREIGN KEY(owner_scope_id,belief_slot_id) REFERENCES belief_slots(owner_scope_id,id),
 CONSTRAINT slot_fingerprints_window CHECK(valid_to_recorded_at IS NULL OR valid_to_recorded_at >= valid_from_recorded_at)
);
CREATE INDEX slot_fingerprints_lookup ON slot_fingerprints(owner_scope_id,normalization_version,fingerprint)
 WHERE valid_to_recorded_at IS NULL;
CREATE UNIQUE INDEX slot_fingerprints_live ON slot_fingerprints(owner_scope_id,belief_slot_id,normalization_version)
 WHERE valid_to_recorded_at IS NULL;

CREATE TABLE proposition_fingerprints (
 id uuid PRIMARY KEY,
 owner_scope_id uuid NOT NULL REFERENCES owner_scopes(id),
 proposition_id uuid NOT NULL,
 registry_release_id uuid,
 normalization_version text NOT NULL CHECK(normalization_version ~ '^[a-z][a-z0-9_.-]{0,63}$'),
 fingerprint text NOT NULL CHECK(fingerprint ~ '^[a-f0-9]{64}$'),
 descriptor jsonb NOT NULL CHECK(jsonb_typeof(descriptor)='object'),
 valid_from_recorded_at timestamptz NOT NULL DEFAULT now(),
 valid_to_recorded_at timestamptz,
 UNIQUE(owner_scope_id,id),
 FOREIGN KEY(owner_scope_id,proposition_id) REFERENCES propositions(owner_scope_id,id),
 CONSTRAINT proposition_fingerprints_window CHECK(valid_to_recorded_at IS NULL OR valid_to_recorded_at >= valid_from_recorded_at)
);
CREATE INDEX proposition_fingerprints_lookup ON proposition_fingerprints(owner_scope_id,normalization_version,fingerprint)
 WHERE valid_to_recorded_at IS NULL;
CREATE UNIQUE INDEX proposition_fingerprints_live ON proposition_fingerprints(owner_scope_id,proposition_id,normalization_version)
 WHERE valid_to_recorded_at IS NULL;

-- Claims point at a precise source anchor, so the anchor needs the owner-composite
-- key every child reference in this schema uses.
ALTER TABLE source_anchors ADD CONSTRAINT source_anchors_owner_identity UNIQUE(owner_scope_id,id);

-- One source assertion or observation (PRD §11.10). Claims stay distinct even
-- when they support the same proposition, and confidence is multidimensional:
-- extraction, entity resolution, temporal resolution and instance resolution are
-- four separate columns, never one opaque number (PRD §15.3, CRT-MEM-14-A).
--
-- temporal_interpretation keeps what a resolved time phrase actually said:
-- normalized time, the original text, the timezone or locale it was read in, the
-- precision, the resolver version and the resolver's confidence. The check makes
-- a falsely precise interpretation unrepresentable -- a stored interpretation
-- without a precision, or with a precision outside PRD §12.5, is refused.
--
-- extraction_run_id is constrained null until the extraction node delivers
-- extraction_runs; that node's migration replaces the check with its foreign key.
CREATE TABLE claims (
 id uuid PRIMARY KEY,
 owner_scope_id uuid NOT NULL REFERENCES owner_scopes(id),
 source_anchor_id uuid NOT NULL,
 extraction_run_id uuid CHECK(extraction_run_id IS NULL),
 asserted_by_entity_id uuid,
 proposition_id uuid,
 candidate_frame_type_id text CHECK(candidate_frame_type_id ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
 claim_origin text NOT NULL CHECK(claim_origin IN ('USER_STATEMENT','USER_CONFIRMATION','USER_CORRECTION','EXTERNAL_PERSON_ASSERTION','STRUCTURED_CONNECTOR_OBSERVATION','DOCUMENT_ASSERTION','MODEL_EXTRACTION','MODEL_INFERENCE','MODEL_RECOMMENDATION','MODEL_PREDICTION','TOOL_EXECUTION_RECEIPT')),
 lifecycle text NOT NULL DEFAULT 'CANDIDATE' CHECK(lifecycle IN ('CANDIDATE','AWAITING_INSTANCE_RESOLUTION','PROVISIONAL','ACCEPTED','CONTESTED','REJECTED','SUPERSEDED','SUPPRESSED')),
 valid_from timestamptz,
 valid_to timestamptz,
 recorded_at timestamptz NOT NULL DEFAULT now(),
 extraction_confidence numeric CHECK(extraction_confidence >= 0 AND extraction_confidence <= 1),
 entity_resolution_confidence numeric CHECK(entity_resolution_confidence >= 0 AND entity_resolution_confidence <= 1),
 temporal_resolution_confidence numeric CHECK(temporal_resolution_confidence >= 0 AND temporal_resolution_confidence <= 1),
 instance_resolution_confidence numeric CHECK(instance_resolution_confidence >= 0 AND instance_resolution_confidence <= 1),
 temporal_interpretation jsonb,
 metadata jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(metadata)='object'),
 UNIQUE(owner_scope_id,id),
 FOREIGN KEY(owner_scope_id,source_anchor_id) REFERENCES source_anchors(owner_scope_id,id),
 FOREIGN KEY(owner_scope_id,asserted_by_entity_id) REFERENCES entities(owner_scope_id,id),
 FOREIGN KEY(owner_scope_id,proposition_id) REFERENCES propositions(owner_scope_id,id),
 CONSTRAINT claims_interval CHECK(valid_to IS NULL OR valid_from IS NULL OR valid_from <= valid_to),
 -- A claim may wait without a proposition while its instance is unresolved; a
 -- claim the engine has already taken up must name the proposition it supports.
 CONSTRAINT claims_attached_when_admitted CHECK(proposition_id IS NOT NULL
  OR lifecycle IN ('CANDIDATE','AWAITING_INSTANCE_RESOLUTION','REJECTED','SUPPRESSED')),
 CONSTRAINT claims_temporal_interpretation_complete CHECK(temporal_interpretation IS NULL OR (
  jsonb_typeof(temporal_interpretation)='object'
  AND temporal_interpretation ? 'originalText' AND jsonb_typeof(temporal_interpretation->'originalText')='string'
  AND temporal_interpretation ? 'normalizedTime' AND jsonb_typeof(temporal_interpretation->'normalizedTime')='object'
  AND temporal_interpretation ? 'timeZone' AND jsonb_typeof(temporal_interpretation->'timeZone')='string'
  AND temporal_interpretation ? 'resolverVersion' AND jsonb_typeof(temporal_interpretation->'resolverVersion')='string'
  AND temporal_interpretation ? 'confidence' AND jsonb_typeof(temporal_interpretation->'confidence')='number'
  AND temporal_interpretation->>'precision' IN ('EXACT_INSTANT','DAY','MONTH','APPROXIMATE','OPEN_INTERVAL')))
);
CREATE INDEX claims_proposition ON claims(owner_scope_id,proposition_id,recorded_at);
CREATE INDEX claims_anchor ON claims(owner_scope_id,source_anchor_id);
CREATE INDEX claims_awaiting_instance ON claims(owner_scope_id,recorded_at,id)
 WHERE lifecycle='AWAITING_INSTANCE_RESOLUTION';

-- Who or what fills a registry role of one instance. A role is filled either by a
-- resolved entity or by a typed value, and it records the claim that put it there.
CREATE TABLE frame_instance_roles (
 id uuid PRIMARY KEY,
 owner_scope_id uuid NOT NULL REFERENCES owner_scopes(id),
 frame_instance_id uuid NOT NULL,
 role_id text NOT NULL CHECK(role_id ~ '^[a-z][a-z0-9_]{0,63}$'),
 entity_id uuid,
 typed_value jsonb,
 valid_from timestamptz,
 valid_to timestamptz,
 claim_id uuid,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(owner_scope_id,id),
 FOREIGN KEY(owner_scope_id,frame_instance_id) REFERENCES frame_instances(owner_scope_id,id),
 FOREIGN KEY(owner_scope_id,entity_id) REFERENCES entities(owner_scope_id,id),
 FOREIGN KEY(owner_scope_id,claim_id) REFERENCES claims(owner_scope_id,id),
 CONSTRAINT frame_instance_roles_filled CHECK(num_nonnulls(entity_id,typed_value)=1),
 CONSTRAINT frame_instance_roles_interval CHECK(valid_to IS NULL OR valid_from IS NULL OR valid_from <= valid_to)
);
CREATE INDEX frame_instance_roles_instance ON frame_instance_roles(owner_scope_id,frame_instance_id,role_id);
CREATE INDEX frame_instance_roles_entity ON frame_instance_roles(owner_scope_id,entity_id);

-- Purpose gate for canonical identity. `memory.canonicalize` is the write purpose
-- the identity, slot, proposition and claim stores run under; `memory.inspect` is
-- the read purpose behind the Memory inspector. A session holding an unrelated
-- product purpose reads nothing here, and passing `true` makes a missing setting
-- NULL so the policy fails closed.
CREATE FUNCTION unai_private.memory_purpose(allowed text[]) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog
AS $$ SELECT current_setting('unai.purpose',true) = ANY(allowed) $$;
REVOKE ALL ON FUNCTION unai_private.memory_purpose(text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION unai_private.memory_purpose(text[]) TO unai_app;

ALTER TABLE entities ENABLE ROW LEVEL SECURITY;
ALTER TABLE entities FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_read ON entities FOR SELECT TO unai_app
 USING(unai_private.has_owner_access(owner_scope_id) AND unai_private.memory_purpose(ARRAY['memory.canonicalize','memory.inspect']));
CREATE POLICY owner_append ON entities FOR INSERT TO unai_app
 WITH CHECK(unai_private.has_owner_access(owner_scope_id) AND unai_private.memory_purpose(ARRAY['memory.canonicalize']));
-- A merge or split retires an entity; the identity columns stay immutable, so the
-- retired id keeps resolving to exactly the object it always named.
CREATE POLICY owner_retire ON entities FOR UPDATE TO unai_app
 USING(unai_private.has_owner_access(owner_scope_id) AND unai_private.memory_purpose(ARRAY['memory.canonicalize']))
 WITH CHECK(unai_private.has_owner_access(owner_scope_id) AND unai_private.memory_purpose(ARRAY['memory.canonicalize']));
GRANT SELECT,INSERT ON entities TO unai_app;
GRANT UPDATE(lifecycle,retired_at) ON entities TO unai_app;

ALTER TABLE entity_aliases ENABLE ROW LEVEL SECURITY;
ALTER TABLE entity_aliases FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_read ON entity_aliases FOR SELECT TO unai_app
 USING(unai_private.has_owner_access(owner_scope_id) AND unai_private.memory_purpose(ARRAY['memory.canonicalize','memory.inspect'])
 AND EXISTS(SELECT 1 FROM entities e WHERE e.owner_scope_id=entity_aliases.owner_scope_id AND e.id=entity_id));
CREATE POLICY owner_append ON entity_aliases FOR INSERT TO unai_app
 WITH CHECK(unai_private.has_owner_access(owner_scope_id) AND unai_private.memory_purpose(ARRAY['memory.canonicalize'])
 AND EXISTS(SELECT 1 FROM entities e WHERE e.owner_scope_id=entity_aliases.owner_scope_id AND e.id=entity_id));
GRANT SELECT,INSERT ON entity_aliases TO unai_app;

ALTER TABLE entity_lineage ENABLE ROW LEVEL SECURITY;
ALTER TABLE entity_lineage FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_read ON entity_lineage FOR SELECT TO unai_app
 USING(unai_private.has_owner_access(owner_scope_id) AND unai_private.memory_purpose(ARRAY['memory.canonicalize','memory.inspect']));
CREATE POLICY owner_append ON entity_lineage FOR INSERT TO unai_app
 WITH CHECK(unai_private.has_owner_access(owner_scope_id) AND unai_private.memory_purpose(ARRAY['memory.canonicalize']));
GRANT SELECT,INSERT ON entity_lineage TO unai_app;

ALTER TABLE frame_instances ENABLE ROW LEVEL SECURITY;
ALTER TABLE frame_instances FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_read ON frame_instances FOR SELECT TO unai_app
 USING(unai_private.has_owner_access(owner_scope_id) AND unai_private.memory_purpose(ARRAY['memory.canonicalize','memory.inspect']));
CREATE POLICY owner_append ON frame_instances FOR INSERT TO unai_app
 WITH CHECK(unai_private.has_owner_access(owner_scope_id) AND unai_private.memory_purpose(ARRAY['memory.canonicalize']));
GRANT SELECT,INSERT ON frame_instances TO unai_app;

ALTER TABLE frame_instance_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE frame_instance_roles FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_read ON frame_instance_roles FOR SELECT TO unai_app
 USING(unai_private.has_owner_access(owner_scope_id) AND unai_private.memory_purpose(ARRAY['memory.canonicalize','memory.inspect'])
 AND EXISTS(SELECT 1 FROM frame_instances f WHERE f.owner_scope_id=frame_instance_roles.owner_scope_id AND f.id=frame_instance_id));
CREATE POLICY owner_append ON frame_instance_roles FOR INSERT TO unai_app
 WITH CHECK(unai_private.has_owner_access(owner_scope_id) AND unai_private.memory_purpose(ARRAY['memory.canonicalize'])
 AND EXISTS(SELECT 1 FROM frame_instances f WHERE f.owner_scope_id=frame_instance_roles.owner_scope_id AND f.id=frame_instance_id));
GRANT SELECT,INSERT ON frame_instance_roles TO unai_app;

ALTER TABLE belief_slots ENABLE ROW LEVEL SECURITY;
ALTER TABLE belief_slots FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_read ON belief_slots FOR SELECT TO unai_app
 USING(unai_private.has_owner_access(owner_scope_id) AND unai_private.memory_purpose(ARRAY['memory.canonicalize','memory.inspect']));
CREATE POLICY owner_append ON belief_slots FOR INSERT TO unai_app
 WITH CHECK(unai_private.has_owner_access(owner_scope_id) AND unai_private.memory_purpose(ARRAY['memory.canonicalize']));
GRANT SELECT,INSERT ON belief_slots TO unai_app;

ALTER TABLE propositions ENABLE ROW LEVEL SECURITY;
ALTER TABLE propositions FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_read ON propositions FOR SELECT TO unai_app
 USING(unai_private.has_owner_access(owner_scope_id) AND unai_private.memory_purpose(ARRAY['memory.canonicalize','memory.inspect']));
CREATE POLICY owner_append ON propositions FOR INSERT TO unai_app
 WITH CHECK(unai_private.has_owner_access(owner_scope_id) AND unai_private.memory_purpose(ARRAY['memory.canonicalize']));
GRANT SELECT,INSERT ON propositions TO unai_app;

ALTER TABLE claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE claims FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_read ON claims FOR SELECT TO unai_app
 USING(unai_private.has_owner_access(owner_scope_id) AND unai_private.memory_purpose(ARRAY['memory.canonicalize','memory.inspect']));
CREATE POLICY owner_append ON claims FOR INSERT TO unai_app
 WITH CHECK(unai_private.has_owner_access(owner_scope_id) AND unai_private.memory_purpose(ARRAY['memory.canonicalize']));
GRANT SELECT,INSERT ON claims TO unai_app;

-- The fingerprint tables take the one update the lookup index needs: closing a
-- recorded-time window when a new normalization version supersedes it. Every
-- other column is immutable, enforced below, so recomputation can never rewrite
-- what an earlier fingerprint said.
ALTER TABLE slot_fingerprints ENABLE ROW LEVEL SECURITY;
ALTER TABLE slot_fingerprints FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_read ON slot_fingerprints FOR SELECT TO unai_app
 USING(unai_private.has_owner_access(owner_scope_id) AND unai_private.memory_purpose(ARRAY['memory.canonicalize','memory.inspect']));
CREATE POLICY owner_append ON slot_fingerprints FOR INSERT TO unai_app
 WITH CHECK(unai_private.has_owner_access(owner_scope_id) AND unai_private.memory_purpose(ARRAY['memory.canonicalize']));
CREATE POLICY owner_close ON slot_fingerprints FOR UPDATE TO unai_app
 USING(unai_private.has_owner_access(owner_scope_id) AND unai_private.memory_purpose(ARRAY['memory.canonicalize']))
 WITH CHECK(unai_private.has_owner_access(owner_scope_id) AND unai_private.memory_purpose(ARRAY['memory.canonicalize']));
GRANT SELECT,INSERT ON slot_fingerprints TO unai_app;
GRANT UPDATE(valid_to_recorded_at) ON slot_fingerprints TO unai_app;

ALTER TABLE proposition_fingerprints ENABLE ROW LEVEL SECURITY;
ALTER TABLE proposition_fingerprints FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_read ON proposition_fingerprints FOR SELECT TO unai_app
 USING(unai_private.has_owner_access(owner_scope_id) AND unai_private.memory_purpose(ARRAY['memory.canonicalize','memory.inspect']));
CREATE POLICY owner_append ON proposition_fingerprints FOR INSERT TO unai_app
 WITH CHECK(unai_private.has_owner_access(owner_scope_id) AND unai_private.memory_purpose(ARRAY['memory.canonicalize']));
CREATE POLICY owner_close ON proposition_fingerprints FOR UPDATE TO unai_app
 USING(unai_private.has_owner_access(owner_scope_id) AND unai_private.memory_purpose(ARRAY['memory.canonicalize']))
 WITH CHECK(unai_private.has_owner_access(owner_scope_id) AND unai_private.memory_purpose(ARRAY['memory.canonicalize']));
GRANT SELECT,INSERT ON proposition_fingerprints TO unai_app;
GRANT UPDATE(valid_to_recorded_at) ON proposition_fingerprints TO unai_app;

-- An id, once issued, names one object for good: nothing below may be rewritten
-- into a different object, and no id is ever repurposed (PRD §13.1, §44.13).
CREATE FUNCTION unai_private.canonical_identity_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF NEW.id<>OLD.id OR NEW.owner_scope_id<>OLD.owner_scope_id OR NEW.created_at<>OLD.created_at THEN
  RAISE EXCEPTION 'CANONICAL_IDENTITY_IMMUTABLE' USING ERRCODE='55000';
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION unai_private.canonical_identity_immutable() FROM PUBLIC;
CREATE TRIGGER entity_identity_immutable BEFORE UPDATE ON entities
 FOR EACH ROW EXECUTE FUNCTION unai_private.canonical_identity_immutable();

-- A fingerprint row is an append-only statement about one (release, normalization
-- version) pair. Only its closing timestamp may ever move.
CREATE FUNCTION unai_private.fingerprint_close_only() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF NEW.id<>OLD.id OR NEW.owner_scope_id<>OLD.owner_scope_id OR NEW.normalization_version<>OLD.normalization_version
  OR NEW.fingerprint<>OLD.fingerprint OR NEW.descriptor<>OLD.descriptor
  OR NEW.valid_from_recorded_at<>OLD.valid_from_recorded_at
  OR NEW.registry_release_id IS DISTINCT FROM OLD.registry_release_id THEN
  RAISE EXCEPTION 'FINGERPRINT_IMMUTABLE' USING ERRCODE='55000';
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION unai_private.fingerprint_close_only() FROM PUBLIC;
CREATE TRIGGER slot_fingerprint_close_only BEFORE UPDATE ON slot_fingerprints
 FOR EACH ROW EXECUTE FUNCTION unai_private.fingerprint_close_only();
CREATE TRIGGER proposition_fingerprint_close_only BEFORE UPDATE ON proposition_fingerprints
 FOR EACH ROW EXECUTE FUNCTION unai_private.fingerprint_close_only();

-- Claims take no UPDATE privilege here. A claim is one source assertion, and this
-- node delivers only the recording of it: re-extraction appends a new claim row
-- rather than editing an existing one (PRD §22.1). The belief-transaction node
-- that moves a claim through its lifecycle adds its own update policy, grant and
-- identity guard.

-- Handoff from the evidence node: source_items.actor_entity_id was declared
-- `CHECK(actor_entity_id IS NULL)` because entities did not exist yet. The
-- canonical entity table exists now, so the placeholder gives way to the real
-- composite owner foreign key. No value is backfilled here: filling the column
-- from the retained actor_ref is runtime work for the entity service, and
-- actor_ref, content_hash and raw_object_ref stay exactly as ingested.
ALTER TABLE source_items DROP CONSTRAINT source_items_actor_entity_id_check;
ALTER TABLE source_items ADD CONSTRAINT source_items_actor_entity
 FOREIGN KEY(owner_scope_id,actor_entity_id) REFERENCES entities(owner_scope_id,id);
