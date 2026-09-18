-- The Context Broker, the inspection reads and memory threads (design entities
-- `context_packets`, `memory_threads`, `memory_thread_members`; PRD §21.4, §23,
-- §33.11, §33.14, §35.7, §35.8). ADR 0022 records the decisions below before the
-- code.
--
-- Four rules are carried by the schema rather than by convention:
--
--  1. `memory.read` is the model and plugin read purpose, and it is a *read*.
--     Every SELECT policy reproduced below gains it; no INSERT, UPDATE or DELETE
--     policy on any canonical table admits it, so the only row a broker read can
--     write anywhere is the `context_packets` record of what it answered
--     (PRD §23, FR-060).
--  2. A thread membership creates no evidence. `memory_thread_members` carries no
--     evidence column and no INSERT policy on `source_items` admits
--     `memory.thread`, so putting one object in a second thread cannot produce a
--     second evidence row (CRT-RD-10-A).
--  3. A packet is a record of what was supplied, never a revisable document. The
--     immutability trigger refuses every UPDATE, and no DELETE is granted.
--  4. A sensitivity label is not content. `unai_private.evidence_labels` answers
--     the classification of the owner's own evidence above the request ceiling so
--     a withheld object can be *listed* as a redaction; it returns no text, no
--     object key and no metadata, and the row policies still decide what may be
--     read (CRT-SEC-09-A).

-- The Context Broker and the Memory inspector read evidence: an anchor is what a
-- claim is grounded in, and a packet that cites one has to be able to read the
-- item's sensitivity and allowed purposes. Both purposes join the ones
-- `evidence_access` admits; the data purpose and the sensitivity ceiling still
-- decide, exactly as 0011, 0012 and 0014 each left them (CRT-SEC-02-A).
CREATE OR REPLACE FUNCTION unai_private.evidence_access(purposes text[], sensitivity text) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT current_setting('unai.purpose',true) IN ('evidence.ingest','evidence.read','connector.read','memory.extract','memory.canonicalize','memory.govern','memory.correct','memory.read','memory.inspect')
 AND current_setting('unai.data_purpose',true)=ANY(purposes)
 AND array_position(ARRAY['NORMAL','PRIVATE','RESTRICTED'],sensitivity)
 <= array_position(ARRAY['NORMAL','PRIVATE','RESTRICTED'],current_setting('unai.maximum_sensitivity',true))
$$;

-- What the broker may learn about evidence it may not read.
--
-- CRT-SEC-09-A requires two things at once: a PRIVATE request receives no
-- RESTRICTED object, and the objects it did not receive are *listed* as
-- redactions rather than silently dropped. A row policy that hides the item
-- entirely cannot satisfy the second half, so the classification is answered
-- separately from the content. This function returns the item id, its
-- sensitivity and its allowed purposes for one owner and nothing else: no raw
-- text, no object key, no metadata, no anchor. It is SECURITY DEFINER because
-- the point is to see above the request's ceiling, and it re-checks live owner
-- membership and the read purpose itself rather than trusting the caller.
CREATE FUNCTION unai_private.evidence_labels(owner uuid)
RETURNS TABLE(source_item_id uuid, sensitivity text, allowed_purposes text[])
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT s.id, s.sensitivity, s.allowed_purposes FROM public.source_items s
 WHERE s.owner_scope_id=owner AND s.deleted_at IS NULL
   AND unai_private.has_owner_access(owner)
   AND current_setting('unai.purpose',true) IN ('memory.read','memory.inspect')
$$;
REVOKE ALL ON FUNCTION unai_private.evidence_labels(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION unai_private.evidence_labels(uuid) TO unai_app;

-- A worldline: the situation a set of objects belongs to (PRD §33.11). A thread
-- is a grouping, never a container. It owns nothing, stores no belief, and
-- deleting it would remove no memory.
CREATE TABLE memory_threads (
 id uuid PRIMARY KEY,
 owner_scope_id uuid NOT NULL REFERENCES owner_scopes(id),
 display_title text CHECK(display_title IS NULL OR length(display_title) BETWEEN 1 AND 200),
 lifecycle text NOT NULL DEFAULT 'ACTIVE' CHECK(lifecycle IN ('ACTIVE','DORMANT','CLOSED','MERGED','RETIRED')),
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(owner_scope_id,id)
);
CREATE INDEX memory_threads_owner ON memory_threads(owner_scope_id,lifecycle,created_at);

-- Membership, and only membership. The primary key is the membership itself, so
-- adding the same object to the same thread twice is one row whatever repeats the
-- request; and because the row names an object that already exists, joining a
-- second thread duplicates neither the evidence nor the semantic object
-- (CRT-RD-10-A, CRT-MEM-02-A).
CREATE TABLE memory_thread_members (
 owner_scope_id uuid NOT NULL REFERENCES owner_scopes(id),
 memory_thread_id uuid NOT NULL,
 object_type text NOT NULL CHECK(object_type IN ('frame_instance','proposition','claim','entity','resolution_assertion')),
 object_id uuid NOT NULL,
 membership_kind text NOT NULL CHECK(membership_kind IN ('SUBJECT','PARTICIPANT','PLAN','EVENT','OUTCOME','RELATED')),
 confidence numeric CHECK(confidence IS NULL OR (confidence>=0 AND confidence<=1)),
 transaction_id uuid,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(owner_scope_id,memory_thread_id,object_type,object_id),
 FOREIGN KEY(owner_scope_id,memory_thread_id) REFERENCES memory_threads(owner_scope_id,id),
 FOREIGN KEY(owner_scope_id,transaction_id) REFERENCES belief_transactions(owner_scope_id,id)
);
-- The other direction: every thread one object belongs to, which is what makes
-- "this item is in both threads" a single index scan.
CREATE INDEX memory_thread_members_object ON memory_thread_members(owner_scope_id,object_type,object_id);

-- What was supplied to a model or a plugin, and on whose authority (PRD §23.5,
-- §23.6, §33.14). The request is stored beside the packet because a packet
-- without its purpose, ceiling and risk cannot be audited afterwards.
CREATE TABLE context_packets (
 id uuid PRIMARY KEY,
 owner_scope_id uuid NOT NULL REFERENCES owner_scopes(id),
 purpose text NOT NULL CHECK(purpose ~ '^[A-Z][A-Z0-9_]{0,63}$'),
 requesting_actor_id uuid NOT NULL,
 answer_type_classification text NOT NULL CHECK(answer_type_classification IN ('CURRENT_VALUE','CORRECTED_HISTORICAL_VALUE',
  'HISTORICAL_BELIEF_STATE','EPISODE_RECALL','OPEN_COMMITMENTS','FUTURE_PLANS','PREDICTION_VERSUS_OUTCOME','AGGREGATION',
  'CAUSAL_EXPLANATION','CONTRADICTION_DETECTION','PATTERN_REVIEW','SOURCE_LOOKUP','DECISION_RECONSTRUCTION')),
 request jsonb NOT NULL CHECK(jsonb_typeof(request)='object'),
 packet jsonb NOT NULL CHECK(jsonb_typeof(packet)='object'),
 packet_hash text NOT NULL CHECK(packet_hash ~ '^[a-f0-9]{64}$'),
 -- The pinned release the packet was assembled under, recorded like every other
 -- pin in an owner-scoped table: a plain column, because the release table is
 -- global reference data the application role holds no privilege on (ADR 0011).
 registry_release_id uuid,
 selection_reason jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(selection_reason)='object'),
 created_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz,
 UNIQUE(owner_scope_id,id),
 FOREIGN KEY(owner_scope_id,requesting_actor_id) REFERENCES owner_scope_members(owner_scope_id,user_id)
);
CREATE INDEX context_packets_owner ON context_packets(owner_scope_id,created_at DESC);

ALTER TABLE memory_threads ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory_threads FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_read ON memory_threads FOR SELECT TO unai_app
 USING(unai_private.has_owner_access(owner_scope_id)
 AND unai_private.memory_purpose(ARRAY['memory.read','memory.inspect','memory.thread','memory.govern','memory.canonicalize']));
-- A thread is opened by the path that recognized the worldline -- canonicalization
-- or a governed write -- or by the thread surface itself. No model read purpose
-- appears here.
CREATE POLICY owner_open ON memory_threads FOR INSERT TO unai_app
 WITH CHECK(unai_private.has_owner_access(owner_scope_id)
 AND unai_private.memory_purpose(ARRAY['memory.thread','memory.govern','memory.canonicalize']));
CREATE POLICY owner_retitle ON memory_threads FOR UPDATE TO unai_app
 USING(unai_private.has_owner_access(owner_scope_id) AND unai_private.memory_purpose(ARRAY['memory.thread','memory.govern']))
 WITH CHECK(unai_private.has_owner_access(owner_scope_id) AND unai_private.memory_purpose(ARRAY['memory.thread','memory.govern']));
GRANT SELECT,INSERT ON memory_threads TO unai_app;
GRANT UPDATE(display_title,lifecycle) ON memory_threads TO unai_app;

ALTER TABLE memory_thread_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory_thread_members FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_read ON memory_thread_members FOR SELECT TO unai_app
 USING(unai_private.has_owner_access(owner_scope_id)
 AND unai_private.memory_purpose(ARRAY['memory.read','memory.inspect','memory.thread','memory.govern','memory.canonicalize'])
 AND EXISTS(SELECT 1 FROM memory_threads t WHERE t.owner_scope_id=memory_thread_members.owner_scope_id AND t.id=memory_thread_id));
CREATE POLICY owner_attach ON memory_thread_members FOR INSERT TO unai_app
 WITH CHECK(unai_private.has_owner_access(owner_scope_id)
 AND unai_private.memory_purpose(ARRAY['memory.thread','memory.govern','memory.canonicalize'])
 AND EXISTS(SELECT 1 FROM memory_threads t WHERE t.owner_scope_id=memory_thread_members.owner_scope_id AND t.id=memory_thread_id));
GRANT SELECT,INSERT ON memory_thread_members TO unai_app;

ALTER TABLE context_packets ENABLE ROW LEVEL SECURITY;
ALTER TABLE context_packets FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_read ON context_packets FOR SELECT TO unai_app
 USING(unai_private.has_owner_access(owner_scope_id)
 AND unai_private.memory_purpose(ARRAY['memory.read','memory.inspect','memory.govern']));
-- Assembled only by the Context Broker, and the actor it names is the session's.
CREATE POLICY owner_assemble ON context_packets FOR INSERT TO unai_app
 WITH CHECK(unai_private.has_owner_access(owner_scope_id) AND unai_private.memory_purpose(ARRAY['memory.read'])
 AND requesting_actor_id=unai_private.actor_id());
GRANT SELECT,INSERT ON context_packets TO unai_app;

-- A packet states what was supplied at one instant. Nothing about it is revised.
CREATE TRIGGER context_packets_immutable BEFORE UPDATE ON context_packets
 FOR EACH ROW EXECUTE FUNCTION unai_private.canonicalization_record_immutable();
CREATE TRIGGER memory_thread_members_immutable BEFORE UPDATE ON memory_thread_members
 FOR EACH ROW EXECUTE FUNCTION unai_private.canonicalization_record_immutable();

-- A thread keeps its identity and its owner for as long as it exists: retitling
-- or closing it may not turn it into another owner's thread.
CREATE FUNCTION unai_private.memory_thread_identity() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF NEW.id<>OLD.id OR NEW.owner_scope_id<>OLD.owner_scope_id OR NEW.created_at<>OLD.created_at THEN
  RAISE EXCEPTION 'MEMORY_THREAD_IDENTITY_IMMUTABLE' USING ERRCODE='55000';
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION unai_private.memory_thread_identity() FROM PUBLIC;
CREATE TRIGGER memory_threads_identity BEFORE UPDATE ON memory_threads
 FOR EACH ROW EXECUTE FUNCTION unai_private.memory_thread_identity();

-- What `memory.read` may read, and what `memory.thread` may read to check that
-- the object it is asked to attach exists.
--
-- These are the same SELECT policies the earlier migrations installed, reproduced
-- whole with the two purposes added, because a policy is replaced and never
-- amended. `memory.read` appears in no write policy anywhere: the model and
-- plugin read path can traverse the owner's memory and cannot change one row of
-- it. `memory.thread` is narrower still -- the four object tables a membership
-- may name, and nothing else.
DROP POLICY owner_read ON frame_instances;
CREATE POLICY owner_read ON frame_instances FOR SELECT TO unai_app
 USING(unai_private.has_owner_access(owner_scope_id)
 AND unai_private.memory_purpose(ARRAY['memory.canonicalize','memory.govern','memory.inspect','memory.correct','memory.project','memory.read','memory.thread']));
DROP POLICY owner_read ON frame_instance_roles;
CREATE POLICY owner_read ON frame_instance_roles FOR SELECT TO unai_app
 USING(unai_private.has_owner_access(owner_scope_id)
 AND unai_private.memory_purpose(ARRAY['memory.canonicalize','memory.govern','memory.inspect','memory.project','memory.read'])
 AND EXISTS(SELECT 1 FROM frame_instances f WHERE f.owner_scope_id=frame_instance_roles.owner_scope_id AND f.id=frame_instance_id));
DROP POLICY owner_read ON belief_slots;
CREATE POLICY owner_read ON belief_slots FOR SELECT TO unai_app
 USING(unai_private.has_owner_access(owner_scope_id)
 AND unai_private.memory_purpose(ARRAY['memory.canonicalize','memory.govern','memory.inspect','memory.correct','memory.project','memory.read']));
DROP POLICY owner_read ON propositions;
CREATE POLICY owner_read ON propositions FOR SELECT TO unai_app
 USING(unai_private.has_owner_access(owner_scope_id)
 AND unai_private.memory_purpose(ARRAY['memory.canonicalize','memory.govern','memory.inspect','memory.correct','memory.project','memory.read','memory.thread']));
DROP POLICY owner_read ON claims;
CREATE POLICY owner_read ON claims FOR SELECT TO unai_app
 USING(unai_private.has_owner_access(owner_scope_id)
 AND unai_private.memory_purpose(ARRAY['memory.canonicalize','memory.govern','memory.inspect','memory.correct','memory.project','memory.read','memory.thread']));
DROP POLICY owner_read ON entities;
CREATE POLICY owner_read ON entities FOR SELECT TO unai_app
 USING(unai_private.has_owner_access(owner_scope_id)
 AND unai_private.memory_purpose(ARRAY['memory.canonicalize','memory.govern','memory.inspect','memory.project','memory.read','memory.thread']));
DROP POLICY owner_read ON entity_aliases;
CREATE POLICY owner_read ON entity_aliases FOR SELECT TO unai_app
 USING(unai_private.has_owner_access(owner_scope_id)
 AND unai_private.memory_purpose(ARRAY['memory.canonicalize','memory.inspect','memory.read'])
 AND EXISTS(SELECT 1 FROM entities e WHERE e.owner_scope_id=entity_aliases.owner_scope_id AND e.id=entity_id));
DROP POLICY owner_read ON memory_links;
CREATE POLICY owner_read ON memory_links FOR SELECT TO unai_app
 USING(unai_private.has_owner_access(owner_scope_id)
 AND unai_private.memory_purpose(ARRAY['memory.canonicalize','memory.govern','memory.inspect','memory.correct','memory.project','memory.read']));
DROP POLICY owner_read ON resolution_assertions;
CREATE POLICY owner_read ON resolution_assertions FOR SELECT TO unai_app
 USING(unai_private.has_owner_access(owner_scope_id)
 AND unai_private.memory_purpose(ARRAY['memory.canonicalize','memory.govern','memory.inspect','memory.correct','memory.project','memory.read','memory.thread']));
DROP POLICY owner_read ON belief_assessments;
CREATE POLICY owner_read ON belief_assessments FOR SELECT TO unai_app
 USING(unai_private.has_owner_access(owner_scope_id)
 AND unai_private.memory_purpose(ARRAY['memory.govern','memory.canonicalize','memory.inspect','memory.correct','memory.read']));
DROP POLICY owner_read ON belief_support;
CREATE POLICY owner_read ON belief_support FOR SELECT TO unai_app
 USING(unai_private.has_owner_access(owner_scope_id)
 AND unai_private.memory_purpose(ARRAY['memory.govern','memory.canonicalize','memory.inspect','memory.read']));
DROP POLICY owner_read ON claim_relations;
CREATE POLICY owner_read ON claim_relations FOR SELECT TO unai_app
 USING(unai_private.has_owner_access(owner_scope_id)
 AND unai_private.memory_purpose(ARRAY['memory.canonicalize','memory.govern','memory.inspect','memory.read']));
DROP POLICY owner_read ON derived_proposition_dependencies;
CREATE POLICY owner_read ON derived_proposition_dependencies FOR SELECT TO unai_app
 USING(unai_private.has_owner_access(owner_scope_id)
 AND unai_private.memory_purpose(ARRAY['memory.govern','memory.canonicalize','memory.inspect','memory.read']));
DROP POLICY owner_read ON belief_transactions;
CREATE POLICY owner_read ON belief_transactions FOR SELECT TO unai_app
 USING(unai_private.has_owner_access(owner_scope_id)
 AND unai_private.memory_purpose(ARRAY['memory.govern','memory.inspect','memory.correct','memory.project','memory.read']));
DROP POLICY owner_read ON owner_overlay_deltas;
CREATE POLICY owner_read ON owner_overlay_deltas FOR SELECT TO unai_app
 USING(unai_private.has_owner_access(owner_scope_id)
 AND unai_private.memory_purpose(ARRAY['memory.correct','memory.govern','memory.read','memory.inspect',
   'memory.canonicalize','memory.project','projection.read']));

-- The projection fragments a packet carries (PRD §23.2 step 3, §23.5). The broker
-- reads the typed rows the capabilities maintain; it reduces nothing and writes
-- nothing, so only the SELECT policies move.
DROP POLICY owner_read ON open_commitments_projection;
CREATE POLICY owner_read ON open_commitments_projection FOR SELECT TO unai_app
 USING(unai_private.has_owner_access(owner_scope_id)
 AND unai_private.memory_purpose(ARRAY['memory.project','projection.read','memory.inspect','memory.govern','memory.read']));
DROP POLICY owner_read ON obligations_projection;
CREATE POLICY owner_read ON obligations_projection FOR SELECT TO unai_app
 USING(unai_private.has_owner_access(owner_scope_id)
 AND unai_private.memory_purpose(ARRAY['memory.project','projection.read','memory.inspect','memory.govern','memory.read']));
DROP POLICY owner_read ON schedule_projection;
CREATE POLICY owner_read ON schedule_projection FOR SELECT TO unai_app
 USING(unai_private.has_owner_access(owner_scope_id)
 AND unai_private.memory_purpose(ARRAY['memory.project','projection.read','memory.inspect','memory.govern','memory.read']));

-- The read decision itself is persisted like every other port decision: a
-- `memory.thread` attach and a broker read both record their EvaluateMemoryRead
-- verdict (PRD §29.3, CRT-WRT-03-B).
DROP POLICY owner_read ON policy_decisions;
CREATE POLICY owner_read ON policy_decisions FOR SELECT TO unai_app
 USING(unai_private.has_owner_access(owner_scope_id)
 AND unai_private.memory_purpose(ARRAY['memory.govern','memory.read','memory.act','memory.inspect','memory.thread']));
DROP POLICY owner_append ON policy_decisions;
CREATE POLICY owner_append ON policy_decisions FOR INSERT TO unai_app
 WITH CHECK(unai_private.has_owner_access(owner_scope_id)
 AND unai_private.memory_purpose(ARRAY['memory.govern','memory.read','memory.act','memory.inspect','memory.thread']));
