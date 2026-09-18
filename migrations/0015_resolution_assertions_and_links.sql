-- Resolution assertions and protocol links (design entities `resolution_assertions`
-- and `memory_links`; PRD §11.12, §11.13, §16.2-§16.6, §33.7, §33.8, §34.5).
--
-- Outcome state has exactly one home. No frame contract in the registry defines a
-- status predicate (CRT-OUT-01-A), so "the obligation is settled" cannot be
-- written as a value in a belief slot at all: it is a row here, carrying the
-- claim that asserted it and the transition contract that permitted it. That is
-- what makes `resolution_assertions` the *sole* outcome authority rather than one
-- of two competing records.
--
-- Four rules are carried by the schema rather than by convention:
--
--  1. Source frame required, target optional, claim required (PRD §33.8). A
--     target-less owner settlement -- "It is settled; I paid him in cash" -- is
--     the ordinary case, not a degenerate one (CRT-OUT-02-A).
--  2. A resolution names its transition contract. `transition_contract_id` is NOT
--     NULL, so an assertion that references none cannot exist; which outcome
--     codes that contract allows is a registry fact the store checks before the
--     insert (CRT-OUT-04-A).
--  3. Nothing here rewrites what it resolves. Both tables take INSERT and a
--     narrow lifecycle UPDATE and nothing else, and their triggers refuse every
--     other column change, so REALIZES and RESOLVES can only ever *add* a record
--     beside the scheduled event, the commitment or the prediction they speak
--     about (CRT-OUT-03-A, CRT-OUT-05-A).
--  4. Advisory coverage is a cache. It is nullable, it is never read by anything
--     in the kernel, and the check keeps it a fraction so a reader cannot mistake
--     it for a money amount (PRD §16.7, CRT-OUT-06-A).

-- The ten protocol link kinds of PRD §11.13. Open semantic links may exist
-- alongside them, but only these carry belief-engine semantics, so the column is
-- a closed list rather than free text.
CREATE TABLE memory_links (
 id uuid PRIMARY KEY,
 owner_scope_id uuid NOT NULL REFERENCES owner_scopes(id),
 from_object_type text NOT NULL CHECK(from_object_type IN ('frame_instance','proposition','claim','resolution_assertion','entity','source_item')),
 from_object_id uuid NOT NULL,
 to_object_type text NOT NULL CHECK(to_object_type IN ('frame_instance','proposition','claim','resolution_assertion','entity','source_item')),
 to_object_id uuid NOT NULL,
 link_kind text NOT NULL CHECK(link_kind IN ('SUPPORTS','CONTRADICTS','SUPERSEDES','DERIVED_FROM','SAME_AS','NOT_SAME_AS','PART_OF','REFERENCES','REALIZES','RESOLVES')),
 lifecycle text NOT NULL DEFAULT 'PROPOSED' CHECK(lifecycle IN ('PROPOSED','ACTIVE','CONTESTED','RETRACTED','SUPERSEDED')),
 -- The transition contract that permitted it. Required for REALIZES and RESOLVES
 -- (PRD §34.5 rule 5, FR-034); null for the eight links that need no transition.
 transition_contract_id text CHECK(transition_contract_id ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
 metadata jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(metadata)='object'),
 transaction_id uuid,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(owner_scope_id,id),
 FOREIGN KEY(owner_scope_id,transaction_id) REFERENCES belief_transactions(owner_scope_id,id),
 CONSTRAINT memory_link_endpoints_distinct CHECK(from_object_type<>to_object_type OR from_object_id<>to_object_id),
 CONSTRAINT memory_link_transition_named CHECK(link_kind NOT IN ('REALIZES','RESOLVES') OR transition_contract_id IS NOT NULL)
);
CREATE INDEX memory_links_from ON memory_links(owner_scope_id,from_object_type,from_object_id,link_kind);
CREATE INDEX memory_links_to ON memory_links(owner_scope_id,to_object_type,to_object_id,link_kind);

-- PRD §33.8. `source_frame_instance_id` is the frame whose outcome this asserts;
-- `target_*` is the thing that brought the outcome about, when there is one.
CREATE TABLE resolution_assertions (
 id uuid PRIMARY KEY,
 owner_scope_id uuid NOT NULL REFERENCES owner_scopes(id),
 source_frame_instance_id uuid NOT NULL,
 source_proposition_id uuid,
 target_frame_instance_id uuid,
 target_proposition_id uuid,
 outcome_code text NOT NULL CHECK(outcome_code IN ('FULFILLED','PARTIALLY_FULFILLED','WAIVED','CANCELLED','WITHDRAWN','FAILED','MISSED','OCCURRED','OCCURRED_MODIFIED','CONFIRMED','REFUTED','PARTIALLY_CONFIRMED')),
 effective_at timestamptz NOT NULL,
 asserted_by_entity_id uuid NOT NULL,
 claim_id uuid NOT NULL,
 transition_contract_id text NOT NULL CHECK(transition_contract_id ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
 lifecycle text NOT NULL DEFAULT 'PROPOSED' CHECK(lifecycle IN ('PROPOSED','ACCEPTED','CONTESTED','REJECTED','SUPERSEDED','WITHDRAWN')),
 -- A cache of what a capability computed, never an input to anything (PRD §16.7).
 advisory_coverage numeric CHECK(advisory_coverage >= 0 AND advisory_coverage <= 1),
 resolution_link_id uuid,
 creation_transaction_id uuid,
 metadata jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(metadata)='object'),
 recorded_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(owner_scope_id,id),
 FOREIGN KEY(owner_scope_id,source_frame_instance_id) REFERENCES frame_instances(owner_scope_id,id),
 FOREIGN KEY(owner_scope_id,source_proposition_id) REFERENCES propositions(owner_scope_id,id),
 FOREIGN KEY(owner_scope_id,target_frame_instance_id) REFERENCES frame_instances(owner_scope_id,id),
 FOREIGN KEY(owner_scope_id,target_proposition_id) REFERENCES propositions(owner_scope_id,id),
 FOREIGN KEY(owner_scope_id,asserted_by_entity_id) REFERENCES entities(owner_scope_id,id),
 FOREIGN KEY(owner_scope_id,claim_id) REFERENCES claims(owner_scope_id,id),
 FOREIGN KEY(owner_scope_id,resolution_link_id) REFERENCES memory_links(owner_scope_id,id),
 FOREIGN KEY(owner_scope_id,creation_transaction_id) REFERENCES belief_transactions(owner_scope_id,id),
 -- A resolution never resolves itself: the frame that brought the outcome about
 -- is a different instance from the one being resolved (PRD §44.7 -- the actual
 -- occurrence and the scheduled event are separate instances).
 CONSTRAINT resolution_target_distinct CHECK(target_frame_instance_id IS NULL OR target_frame_instance_id<>source_frame_instance_id),
 -- A target proposition belongs to the target frame, so naming one without the
 -- other would leave the assertion pointing at nothing identifiable.
 CONSTRAINT resolution_target_proposition_framed CHECK(target_proposition_id IS NULL OR target_frame_instance_id IS NOT NULL)
);
CREATE INDEX resolution_assertions_source ON resolution_assertions(owner_scope_id,source_frame_instance_id,lifecycle);
CREATE INDEX resolution_assertions_target ON resolution_assertions(owner_scope_id,target_frame_instance_id);
CREATE INDEX resolution_assertions_claim ON resolution_assertions(owner_scope_id,claim_id);

ALTER TABLE memory_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory_links FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_read ON memory_links FOR SELECT TO unai_app
 USING(unai_private.has_owner_access(owner_scope_id)
 AND unai_private.memory_purpose(ARRAY['memory.canonicalize','memory.govern','memory.inspect','memory.correct']));
CREATE POLICY owner_append ON memory_links FOR INSERT TO unai_app
 WITH CHECK(unai_private.has_owner_access(owner_scope_id)
 AND unai_private.memory_purpose(ARRAY['memory.canonicalize','memory.govern','memory.correct']));
CREATE POLICY owner_lifecycle ON memory_links FOR UPDATE TO unai_app
 USING(unai_private.has_owner_access(owner_scope_id) AND unai_private.memory_purpose(ARRAY['memory.govern','memory.correct']))
 WITH CHECK(unai_private.has_owner_access(owner_scope_id) AND unai_private.memory_purpose(ARRAY['memory.govern','memory.correct']));
GRANT SELECT,INSERT,UPDATE ON memory_links TO unai_app;

ALTER TABLE resolution_assertions ENABLE ROW LEVEL SECURITY;
ALTER TABLE resolution_assertions FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_read ON resolution_assertions FOR SELECT TO unai_app
 USING(unai_private.has_owner_access(owner_scope_id)
 AND unai_private.memory_purpose(ARRAY['memory.canonicalize','memory.govern','memory.inspect','memory.correct']));
CREATE POLICY owner_append ON resolution_assertions FOR INSERT TO unai_app
 WITH CHECK(unai_private.has_owner_access(owner_scope_id)
 AND unai_private.memory_purpose(ARRAY['memory.canonicalize','memory.govern','memory.correct']));
-- Accepting, contesting or rejecting a resolution is a governed decision or the
-- owner's own correction; canonicalizing a sentence may propose one but never
-- accept it (PRD §19.1, FR-040).
CREATE POLICY owner_lifecycle ON resolution_assertions FOR UPDATE TO unai_app
 USING(unai_private.has_owner_access(owner_scope_id) AND unai_private.memory_purpose(ARRAY['memory.govern','memory.correct']))
 WITH CHECK(unai_private.has_owner_access(owner_scope_id) AND unai_private.memory_purpose(ARRAY['memory.govern','memory.correct']));
GRANT SELECT,INSERT,UPDATE ON resolution_assertions TO unai_app;

-- What a resolution says never changes; only where it stands does. An UPDATE that
-- moved `outcome_code`, the source, the target, the claim or the contract would
-- be a rewrite of the outcome record itself, and one that moved
-- `resolution_link_id` or `source_frame_instance_id` would silently re-point an
-- accepted outcome at another frame. The trigger binds the privileged migration
-- owner too, so no data fix can do it either.
CREATE FUNCTION unai_private.resolution_assertion_transition() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF NEW.id<>OLD.id OR NEW.owner_scope_id<>OLD.owner_scope_id
  OR NEW.source_frame_instance_id<>OLD.source_frame_instance_id
  OR NEW.source_proposition_id IS DISTINCT FROM OLD.source_proposition_id
  OR NEW.target_frame_instance_id IS DISTINCT FROM OLD.target_frame_instance_id
  OR NEW.target_proposition_id IS DISTINCT FROM OLD.target_proposition_id
  OR NEW.outcome_code<>OLD.outcome_code OR NEW.effective_at<>OLD.effective_at
  OR NEW.asserted_by_entity_id<>OLD.asserted_by_entity_id OR NEW.claim_id<>OLD.claim_id
  OR NEW.transition_contract_id<>OLD.transition_contract_id
  OR NEW.resolution_link_id IS DISTINCT FROM OLD.resolution_link_id
  OR NEW.creation_transaction_id IS DISTINCT FROM OLD.creation_transaction_id
  OR NEW.recorded_at<>OLD.recorded_at THEN
  RAISE EXCEPTION 'RESOLUTION_ASSERTION_IMMUTABLE' USING ERRCODE='55000';
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION unai_private.resolution_assertion_transition() FROM PUBLIC;
CREATE TRIGGER resolution_assertions_transition BEFORE UPDATE ON resolution_assertions
 FOR EACH ROW EXECUTE FUNCTION unai_private.resolution_assertion_transition();

CREATE FUNCTION unai_private.memory_link_transition() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF NEW.id<>OLD.id OR NEW.owner_scope_id<>OLD.owner_scope_id
  OR NEW.from_object_type<>OLD.from_object_type OR NEW.from_object_id<>OLD.from_object_id
  OR NEW.to_object_type<>OLD.to_object_type OR NEW.to_object_id<>OLD.to_object_id
  OR NEW.link_kind<>OLD.link_kind
  OR NEW.transition_contract_id IS DISTINCT FROM OLD.transition_contract_id
  OR NEW.transaction_id IS DISTINCT FROM OLD.transaction_id
  OR NEW.created_at<>OLD.created_at THEN
  RAISE EXCEPTION 'MEMORY_LINK_IMMUTABLE' USING ERRCODE='55000';
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION unai_private.memory_link_transition() FROM PUBLIC;
CREATE TRIGGER memory_links_transition BEFORE UPDATE ON memory_links
 FOR EACH ROW EXECUTE FUNCTION unai_private.memory_link_transition();
