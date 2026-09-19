-- Governed merge and split: frame-instance and proposition lineage, governed
-- retirement of a frame instance, and the policy widenings the governed write
-- needs (design entities `frame_instance_lineage`, `proposition_lineage`,
-- `entity_lineage`; PRD §13.1, §13.6, §14, §33.5, §33.6, §35.11, §44.13, §44.14).
-- ADR 0023 records the decisions below before the code.
--
-- Three invariants are carried by the schema rather than by convention:
--
--  1. An old identifier stays resolvable and is never repurposed. Nothing here
--     deletes or rewrites a frame instance, a proposition or an entity. A merged
--     or split object keeps its row and its id; its lifecycle moves once, away
--     from ACTIVE, and a lineage row says where it went. A lineage row is
--     append-only, and a frame is merged into at most one survivor.
--  2. Merge and split are belief transactions, not database shortcuts (PRD §14).
--     A lineage row names its transaction, and a trigger requires that
--     transaction to be a MERGE or SPLIT of the same owner that is committing in
--     this very database transaction. Retiring a frame instance requires a
--     committing belief transaction in the same way. Both triggers bind every
--     principal, the migration owner included.
--  3. Lineage is readable wherever the object it describes is readable, so no
--     read of a merged id fails open or closed on the lineage alone.

-- Where every frame instance merged or split went (PRD §33.5). Kinds mirror
-- `entity_lineage`: MERGED_INTO names the survivor, SPLIT_INTO names each new
-- instance of a split, RETIRED_PARENT is kept for vocabulary parity.
CREATE TABLE frame_instance_lineage (
 id uuid PRIMARY KEY,
 owner_scope_id uuid NOT NULL REFERENCES owner_scopes(id),
 from_frame_instance_id uuid NOT NULL,
 to_frame_instance_id uuid NOT NULL,
 lineage_kind text NOT NULL CHECK(lineage_kind IN ('MERGED_INTO','SPLIT_INTO','RETIRED_PARENT')),
 transaction_id uuid NOT NULL,
 reason jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(reason)='object'),
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(owner_scope_id,id),
 FOREIGN KEY(owner_scope_id,from_frame_instance_id) REFERENCES frame_instances(owner_scope_id,id),
 FOREIGN KEY(owner_scope_id,to_frame_instance_id) REFERENCES frame_instances(owner_scope_id,id),
 FOREIGN KEY(owner_scope_id,transaction_id) REFERENCES belief_transactions(owner_scope_id,id),
 CONSTRAINT frame_instance_lineage_distinct CHECK(from_frame_instance_id <> to_frame_instance_id)
);
CREATE INDEX frame_instance_lineage_from ON frame_instance_lineage(owner_scope_id,from_frame_instance_id,lineage_kind);
CREATE INDEX frame_instance_lineage_to ON frame_instance_lineage(owner_scope_id,to_frame_instance_id,lineage_kind);
CREATE INDEX frame_instance_lineage_transaction ON frame_instance_lineage(owner_scope_id,transaction_id);
-- One survivor per merged id: an id that already resolves to a survivor can never
-- be merged into a second one, which is what "never repurposed" means for a merge.
CREATE UNIQUE INDEX frame_instance_lineage_one_survivor ON frame_instance_lineage(owner_scope_id,from_frame_instance_id)
 WHERE lineage_kind='MERGED_INTO';

-- Where every proposition merged or split went (PRD §13.6, §33.6). The design's
-- three kinds plus SPLIT_INTO, which keeps a split proposition resolvable to the
-- propositions that replaced it (ADR 0023 §2).
CREATE TABLE proposition_lineage (
 id uuid PRIMARY KEY,
 owner_scope_id uuid NOT NULL REFERENCES owner_scopes(id),
 from_proposition_id uuid NOT NULL,
 to_proposition_id uuid NOT NULL,
 lineage_kind text NOT NULL CHECK(lineage_kind IN ('EQUIVALENT_TO','CANONICAL_ALIAS_OF','MERGED_INTO','SPLIT_INTO')),
 transaction_id uuid NOT NULL,
 reason jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(reason)='object'),
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(owner_scope_id,id),
 FOREIGN KEY(owner_scope_id,from_proposition_id) REFERENCES propositions(owner_scope_id,id),
 FOREIGN KEY(owner_scope_id,to_proposition_id) REFERENCES propositions(owner_scope_id,id),
 FOREIGN KEY(owner_scope_id,transaction_id) REFERENCES belief_transactions(owner_scope_id,id),
 CONSTRAINT proposition_lineage_distinct CHECK(from_proposition_id <> to_proposition_id)
);
CREATE INDEX proposition_lineage_from ON proposition_lineage(owner_scope_id,from_proposition_id,lineage_kind);
CREATE INDEX proposition_lineage_to ON proposition_lineage(owner_scope_id,to_proposition_id,lineage_kind);
CREATE UNIQUE INDEX proposition_lineage_one_survivor ON proposition_lineage(owner_scope_id,from_proposition_id)
 WHERE lineage_kind='MERGED_INTO';

-- A lineage row is written only by the MERGE or SPLIT transaction committing right
-- now. Plain invoker rights: the check reads `belief_transactions` under the
-- caller's own row-level security, exactly as the context-move guard of 0012 does.
CREATE FUNCTION unai_private.lineage_governed() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF NEW.transaction_id IS DISTINCT FROM unai_private.governing_belief_transaction()
  OR NOT EXISTS(SELECT 1 FROM public.belief_transactions t
    WHERE t.owner_scope_id=NEW.owner_scope_id AND t.id=NEW.transaction_id
      AND t.status='COMMITTING' AND t.transaction_kind IN ('MERGE','SPLIT')) THEN
  RAISE EXCEPTION 'LINEAGE_REQUIRES_GOVERNED_TRANSACTION' USING ERRCODE='55000';
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION unai_private.lineage_governed() FROM PUBLIC;
CREATE TRIGGER frame_instance_lineage_governed BEFORE INSERT ON frame_instance_lineage
 FOR EACH ROW EXECUTE FUNCTION unai_private.lineage_governed();
CREATE TRIGGER proposition_lineage_governed BEFORE INSERT ON proposition_lineage
 FOR EACH ROW EXECUTE FUNCTION unai_private.lineage_governed();

-- `entity_lineage.transaction_id` stays nullable (ADR 0015, 0017): the canonical
-- identity node's user merge records none. A row that does name a transaction
-- must name the governed one committing now, so a transaction id on an entity
-- lineage row is never a label anybody could have typed in.
CREATE FUNCTION unai_private.entity_lineage_governed() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF NEW.transaction_id IS NOT NULL AND (NEW.transaction_id IS DISTINCT FROM unai_private.governing_belief_transaction()
  OR NOT EXISTS(SELECT 1 FROM public.belief_transactions t
    WHERE t.owner_scope_id=NEW.owner_scope_id AND t.id=NEW.transaction_id
      AND t.status='COMMITTING' AND t.transaction_kind IN ('MERGE','SPLIT'))) THEN
  RAISE EXCEPTION 'LINEAGE_REQUIRES_GOVERNED_TRANSACTION' USING ERRCODE='55000';
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION unai_private.entity_lineage_governed() FROM PUBLIC;
CREATE TRIGGER entity_lineage_governed BEFORE INSERT ON entity_lineage
 FOR EACH ROW EXECUTE FUNCTION unai_private.entity_lineage_governed();

-- Lineage is history. No column of it ever moves, for any principal.
CREATE FUNCTION unai_private.lineage_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 RAISE EXCEPTION 'LINEAGE_IMMUTABLE' USING ERRCODE='55000';
END $$;
REVOKE ALL ON FUNCTION unai_private.lineage_immutable() FROM PUBLIC;
CREATE TRIGGER frame_instance_lineage_immutable BEFORE UPDATE ON frame_instance_lineage
 FOR EACH ROW EXECUTE FUNCTION unai_private.lineage_immutable();
CREATE TRIGGER proposition_lineage_immutable BEFORE UPDATE ON proposition_lineage
 FOR EACH ROW EXECUTE FUNCTION unai_private.lineage_immutable();
CREATE TRIGGER entity_lineage_immutable BEFORE UPDATE ON entity_lineage
 FOR EACH ROW EXECUTE FUNCTION unai_private.lineage_immutable();

-- A frame instance may be retired, and only by a governed transaction. Its
-- identity columns never move, and a retired instance never becomes active again:
-- an id that was merged away cannot come back to name a different situation.
CREATE FUNCTION unai_private.frame_instance_governed_retirement() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF NEW.id<>OLD.id OR NEW.owner_scope_id<>OLD.owner_scope_id OR NEW.frame_type_id<>OLD.frame_type_id
  OR NEW.context_space_id<>OLD.context_space_id OR NEW.created_at<>OLD.created_at
  OR NEW.created_by_transaction_id IS DISTINCT FROM OLD.created_by_transaction_id THEN
  RAISE EXCEPTION 'CANONICAL_IDENTITY_IMMUTABLE' USING ERRCODE='55000';
 END IF;
 IF NEW.lifecycle IS DISTINCT FROM OLD.lifecycle OR NEW.retired_at IS DISTINCT FROM OLD.retired_at THEN
  IF OLD.lifecycle<>'ACTIVE' THEN
   RAISE EXCEPTION 'FRAME_INSTANCE_ALREADY_RETIRED' USING ERRCODE='55000';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public.belief_transactions t
    WHERE t.id=unai_private.governing_belief_transaction()
      AND t.owner_scope_id=NEW.owner_scope_id AND t.status='COMMITTING') THEN
   RAISE EXCEPTION 'FRAME_RETIREMENT_REQUIRES_TRANSACTION' USING ERRCODE='55000';
  END IF;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION unai_private.frame_instance_governed_retirement() FROM PUBLIC;
CREATE TRIGGER frame_instance_governed_retirement BEFORE UPDATE ON frame_instances
 FOR EACH ROW EXECUTE FUNCTION unai_private.frame_instance_governed_retirement();

CREATE POLICY governed_retire ON frame_instances FOR UPDATE TO unai_app
 USING(unai_private.has_owner_access(owner_scope_id) AND unai_private.memory_purpose(ARRAY['memory.govern']))
 WITH CHECK(unai_private.has_owner_access(owner_scope_id) AND unai_private.memory_purpose(ARRAY['memory.govern']));
GRANT UPDATE(lifecycle,retired_at) ON frame_instances TO unai_app;

ALTER TABLE frame_instance_lineage ENABLE ROW LEVEL SECURITY;
ALTER TABLE frame_instance_lineage FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_read ON frame_instance_lineage FOR SELECT TO unai_app
 USING(unai_private.has_owner_access(owner_scope_id)
 AND unai_private.memory_purpose(ARRAY['memory.canonicalize','memory.govern','memory.inspect','memory.correct',
   'memory.project','memory.read','memory.thread','projection.read']));
CREATE POLICY owner_append ON frame_instance_lineage FOR INSERT TO unai_app
 WITH CHECK(unai_private.has_owner_access(owner_scope_id) AND unai_private.memory_purpose(ARRAY['memory.govern']));
GRANT SELECT,INSERT ON frame_instance_lineage TO unai_app;

ALTER TABLE proposition_lineage ENABLE ROW LEVEL SECURITY;
ALTER TABLE proposition_lineage FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_read ON proposition_lineage FOR SELECT TO unai_app
 USING(unai_private.has_owner_access(owner_scope_id)
 AND unai_private.memory_purpose(ARRAY['memory.canonicalize','memory.govern','memory.inspect','memory.correct',
   'memory.project','memory.read','memory.thread','projection.read']));
CREATE POLICY owner_append ON proposition_lineage FOR INSERT TO unai_app
 WITH CHECK(unai_private.has_owner_access(owner_scope_id) AND unai_private.memory_purpose(ARRAY['memory.govern']));
GRANT SELECT,INSERT ON proposition_lineage TO unai_app;

-- The governed merge writes entity identity under `memory.govern`, as every other
-- governed write already writes frames, slots, propositions and claims (0012).
-- Each policy is reproduced whole with its latest predicate plus that one
-- purpose, because a policy is replaced and not amended.
DROP POLICY owner_append ON entities;
CREATE POLICY owner_append ON entities FOR INSERT TO unai_app
 WITH CHECK(unai_private.has_owner_access(owner_scope_id) AND unai_private.memory_purpose(ARRAY['memory.canonicalize','memory.govern']));
DROP POLICY owner_retire ON entities;
CREATE POLICY owner_retire ON entities FOR UPDATE TO unai_app
 USING(unai_private.has_owner_access(owner_scope_id) AND unai_private.memory_purpose(ARRAY['memory.canonicalize','memory.govern']))
 WITH CHECK(unai_private.has_owner_access(owner_scope_id) AND unai_private.memory_purpose(ARRAY['memory.canonicalize','memory.govern']));

DROP POLICY owner_read ON entity_aliases;
CREATE POLICY owner_read ON entity_aliases FOR SELECT TO unai_app
 USING(unai_private.has_owner_access(owner_scope_id)
 AND unai_private.memory_purpose(ARRAY['memory.canonicalize','memory.govern','memory.inspect','memory.read'])
 AND EXISTS(SELECT 1 FROM entities e WHERE e.owner_scope_id=entity_aliases.owner_scope_id AND e.id=entity_id));
DROP POLICY owner_append ON entity_aliases;
CREATE POLICY owner_append ON entity_aliases FOR INSERT TO unai_app
 WITH CHECK(unai_private.has_owner_access(owner_scope_id) AND unai_private.memory_purpose(ARRAY['memory.canonicalize','memory.govern'])
 AND EXISTS(SELECT 1 FROM entities e WHERE e.owner_scope_id=entity_aliases.owner_scope_id AND e.id=entity_id));

DROP POLICY owner_read ON entity_lineage;
CREATE POLICY owner_read ON entity_lineage FOR SELECT TO unai_app
 USING(unai_private.has_owner_access(owner_scope_id)
 AND unai_private.memory_purpose(ARRAY['memory.canonicalize','memory.govern','memory.inspect','memory.correct',
   'memory.project','memory.read','memory.thread','projection.read']));
DROP POLICY owner_append ON entity_lineage;
CREATE POLICY owner_append ON entity_lineage FOR INSERT TO unai_app
 WITH CHECK(unai_private.has_owner_access(owner_scope_id) AND unai_private.memory_purpose(ARRAY['memory.canonicalize','memory.govern']));

-- Rehoming a merged slot appends a fingerprint version whose descriptor names the
-- survivor and closes the previous one (PRD §14.1 items 3-4); the close is the
-- one update the index admits, now also under the governing purpose.
DROP POLICY owner_close ON slot_fingerprints;
CREATE POLICY owner_close ON slot_fingerprints FOR UPDATE TO unai_app
 USING(unai_private.has_owner_access(owner_scope_id) AND unai_private.memory_purpose(ARRAY['memory.canonicalize','memory.govern']))
 WITH CHECK(unai_private.has_owner_access(owner_scope_id) AND unai_private.memory_purpose(ARRAY['memory.canonicalize','memory.govern']));

-- A split assigns a claim to a new instance's proposition by a support row, never
-- by re-pointing the claim (ADR 0023 §2). The reducer must see that row to count
-- the claim for the new instance, so `memory.project` joins the read list.
DROP POLICY owner_read ON belief_support;
CREATE POLICY owner_read ON belief_support FOR SELECT TO unai_app
 USING(unai_private.has_owner_access(owner_scope_id)
 AND unai_private.memory_purpose(ARRAY['memory.govern','memory.canonicalize','memory.inspect','memory.read','memory.project']));
