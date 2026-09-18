-- Owner read-your-writes and the correction write paths: the per-owner sequence
-- allocator, the overlay delta the next read from any of the owner's devices
-- observes, and the memory operation each correction control persists (design
-- entities `owner_sequences`, `owner_overlay_deltas`, `memory_operations`; PRD
-- §14, §20, §57). ADR 0019 records the decisions below before the code.
--
-- Four rules are carried by the schema rather than by convention:
--
--  1. An owner sequence is allocated, never chosen. `owner_sequences` holds one
--     row per owner scope and the allocator increments it inside the caller's
--     transaction, so two devices writing concurrently block on the same row and
--     receive distinct numbers in commit order (CRT-RYW-01-A).
--  2. The pair is unique. `UNIQUE(owner_scope_id,owner_sequence)` refuses a
--     duplicate whatever principal writes it, so a caller that invents a sequence
--     instead of allocating one is rejected rather than silently accepted.
--  3. A delta is never deleted and never rewritten into another verdict. Only
--     `lifecycle`, `resolved_by_transaction_id`, `contested_reason` and the
--     attachment columns may move, and a CONTESTED delta may not be turned into
--     REJECTED_AS_INTERPRETATION or SUPERSEDED by a re-extraction: those two
--     lifecycles require the owner's own operation (CRT-MEM-15-A, CRT-RYW-05-A).
--  4. Each correction control is its own persisted kind. `memory_operations`
--     carries the ten kinds of PRD §20.2 in a CHECK list, so "edit memory" is
--     unrepresentable (CRT-UX-10-B is the screen's; this is the storage it reads).

-- The correction write path reaches evidence: POST /v1/memory/corrections stores
-- the owner's own words as a new source item before anything canonical is
-- proposed (CRT-RYW-06-A). `memory.correct` joins the purposes `evidence_access`
-- admits and nothing else about the function changes, exactly as 0011 and 0012
-- each added their own.
CREATE OR REPLACE FUNCTION unai_private.evidence_access(purposes text[], sensitivity text) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT current_setting('unai.purpose',true) IN ('evidence.ingest','evidence.read','connector.read','memory.extract','memory.canonicalize','memory.govern','memory.correct')
 AND current_setting('unai.data_purpose',true)=ANY(purposes)
 AND array_position(ARRAY['NORMAL','PRIVATE','RESTRICTED'],sensitivity)
 <= array_position(ARRAY['NORMAL','PRIVATE','RESTRICTED'],current_setting('unai.maximum_sensitivity',true))
$$;

-- One row per owner scope, created on first allocation. `last_sequence` is the
-- highest number handed out; the allocator reads and increments it in one
-- statement, so the row lock it takes is also the serialization point.
CREATE TABLE owner_sequences (
 owner_scope_id uuid PRIMARY KEY REFERENCES owner_scopes(id),
 last_sequence bigint NOT NULL DEFAULT 0 CHECK(last_sequence >= 0),
 updated_at timestamptz NOT NULL DEFAULT now()
);

-- The allocator itself. A plain `INSERT ... ON CONFLICT DO UPDATE ... RETURNING`
-- is atomic and takes the row's write lock, so a second allocator for the same
-- owner waits for the first to commit or roll back: the numbers are distinct and
-- they increase in commit order rather than in statement order (CRT-RYW-01-A).
-- It is a plain function, not SECURITY DEFINER: the caller's own INSERT and
-- UPDATE privileges and the owner policy below decide whether it may run.
CREATE FUNCTION unai_private.allocate_owner_sequence(owner uuid) RETURNS bigint
LANGUAGE sql SET search_path=pg_catalog AS $$
 INSERT INTO public.owner_sequences(owner_scope_id,last_sequence,updated_at) VALUES(owner,1,now())
 ON CONFLICT(owner_scope_id) DO UPDATE SET last_sequence=public.owner_sequences.last_sequence+1,updated_at=now()
 RETURNING last_sequence
$$;
REVOKE ALL ON FUNCTION unai_private.allocate_owner_sequence(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION unai_private.allocate_owner_sequence(uuid) TO unai_app;

-- What the owner asserted, corrected, suppressed, archived or deleted, before any
-- canonicalization has run (PRD §14.2, §20). The row is the read-your-writes
-- record: it carries its own owner sequence, and every device of the owner reads
-- the same table, so a write acknowledged on the phone is in the desktop's next
-- read whether or not a belief transaction has committed (CRT-RYW-02-A).
--
-- `attached_frame_instance_id` and `attached_belief_slot_id` are nullable on
-- purpose: a delta in AWAITING_INSTANCE_RESOLUTION has no frame yet and is found
-- through the candidate columns instead (CRT-RYW-03-A is the broker's; these are
-- the columns it reads).
CREATE TABLE owner_overlay_deltas (
 id uuid PRIMARY KEY,
 owner_scope_id uuid NOT NULL REFERENCES owner_scopes(id),
 owner_sequence bigint NOT NULL CHECK(owner_sequence > 0),
 source_session_id uuid,
 source_device_id uuid,
 source_evidence_id uuid NOT NULL,
 raw_text text NOT NULL CHECK(length(raw_text) BETWEEN 1 AND 8192),
 delta_kind text NOT NULL CHECK(delta_kind IN ('USER_ASSERTION','USER_CORRECTION','USER_STATE_CHANGE','USER_CONFIRMATION',
  'USER_REJECTION','KEEP_UNCERTAIN','SUPPRESSION','ARCHIVE','DELETION','MERGE','SPLIT')),
 lifecycle text NOT NULL DEFAULT 'RECEIVED' CHECK(lifecycle IN ('RECEIVED','USER_ASSERTED','AWAITING_INSTANCE_RESOLUTION',
  'CANONICALIZATION_PENDING','COMMITTED','CONTESTED','REJECTED_AS_INTERPRETATION','WITHDRAWN','SUPERSEDED')),
 target_object_type text CHECK(target_object_type IS NULL OR target_object_type IN ('claim','proposition','belief_slot','frame_instance','entity','resolution_assertion')),
 target_object_id uuid,
 attached_frame_instance_id uuid,
 attached_belief_slot_id uuid,
 candidate_entity_refs uuid[] NOT NULL DEFAULT '{}',
 candidate_worldline_refs uuid[] NOT NULL DEFAULT '{}',
 candidate_frame_types text[] NOT NULL DEFAULT '{}',
 discourse_anchor text CHECK(discourse_anchor IS NULL OR length(discourse_anchor) BETWEEN 1 AND 512),
 temporal_hints jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(temporal_hints)='object'),
 embedding_id uuid,
 created_at timestamptz NOT NULL DEFAULT now(),
 resolved_by_transaction_id uuid,
 contested_reason jsonb CHECK(contested_reason IS NULL OR jsonb_typeof(contested_reason)='object'),
 UNIQUE(owner_scope_id,id),
 -- CRT-RYW-01-A: the pair is the owner's write order and a second row cannot
 -- claim a number that was already handed out.
 UNIQUE(owner_scope_id,owner_sequence),
 FOREIGN KEY(owner_scope_id,source_evidence_id) REFERENCES source_items(owner_scope_id,id),
 FOREIGN KEY(owner_scope_id,attached_frame_instance_id) REFERENCES frame_instances(owner_scope_id,id),
 FOREIGN KEY(owner_scope_id,attached_belief_slot_id) REFERENCES belief_slots(owner_scope_id,id),
 FOREIGN KEY(owner_scope_id,resolved_by_transaction_id) REFERENCES belief_transactions(owner_scope_id,id),
 CONSTRAINT overlay_target_complete CHECK((target_object_type IS NULL)=(target_object_id IS NULL)),
 -- A contested delta says why. The reason carries the failure, the conflicting
 -- evidence, the affected projections and the manifests that contained it.
 CONSTRAINT overlay_contested_explained CHECK(lifecycle<>'CONTESTED' OR contested_reason IS NOT NULL)
);
-- The read-your-writes read: everything this owner wrote at or after a watermark,
-- in allocation order.
CREATE INDEX owner_overlay_deltas_sequence ON owner_overlay_deltas(owner_scope_id,owner_sequence);
CREATE INDEX owner_overlay_deltas_target ON owner_overlay_deltas(owner_scope_id,target_object_type,target_object_id,owner_sequence);
CREATE INDEX owner_overlay_deltas_attached ON owner_overlay_deltas(owner_scope_id,attached_frame_instance_id,owner_sequence);
CREATE INDEX owner_overlay_deltas_lifecycle ON owner_overlay_deltas(owner_scope_id,lifecycle,owner_sequence);

-- One row per correction control the owner used (PRD §20.2). The ten kinds are a
-- CHECK list rather than free text, so the Correction controls screen cannot
-- collapse into a single edit action and a later reader can tell a suppression
-- from an archive from a deletion.
CREATE TABLE memory_operations (
 id uuid PRIMARY KEY,
 owner_scope_id uuid NOT NULL REFERENCES owner_scopes(id),
 operation_kind text NOT NULL CHECK(operation_kind IN ('CORRECT','CHANGED','CONFIRM','REJECT','KEEP_UNCERTAIN','SUPPRESS','ARCHIVE','DELETE','MERGE','SPLIT')),
 target_object_type text NOT NULL CHECK(target_object_type IN ('claim','proposition','belief_slot','frame_instance','entity','resolution_assertion')),
 target_object_id uuid NOT NULL,
 overlay_delta_id uuid,
 evidence_id uuid NOT NULL,
 transaction_id uuid,
 requested_by_actor_id uuid NOT NULL,
 detail jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(detail)='object'),
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(owner_scope_id,id),
 FOREIGN KEY(owner_scope_id,overlay_delta_id) REFERENCES owner_overlay_deltas(owner_scope_id,id),
 FOREIGN KEY(owner_scope_id,evidence_id) REFERENCES source_items(owner_scope_id,id),
 FOREIGN KEY(owner_scope_id,transaction_id) REFERENCES belief_transactions(owner_scope_id,id),
 FOREIGN KEY(owner_scope_id,requested_by_actor_id) REFERENCES owner_scope_members(owner_scope_id,user_id)
);
CREATE INDEX memory_operations_target ON memory_operations(owner_scope_id,target_object_type,target_object_id,created_at);
CREATE INDEX memory_operations_kind ON memory_operations(owner_scope_id,operation_kind,created_at);

-- Purposes. `memory.correct` is the correction write path's own purpose, pinned
-- by the URL mapping at the boundary; `memory.read` and `memory.inspect` read the
-- overlay back without being able to write it.
ALTER TABLE owner_sequences ENABLE ROW LEVEL SECURITY;
ALTER TABLE owner_sequences FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_read ON owner_sequences FOR SELECT TO unai_app
 USING(unai_private.has_owner_access(owner_scope_id)
 AND unai_private.memory_purpose(ARRAY['memory.correct','memory.govern','memory.read','memory.inspect']));
CREATE POLICY owner_allocate ON owner_sequences FOR INSERT TO unai_app
 WITH CHECK(unai_private.has_owner_access(owner_scope_id) AND unai_private.memory_purpose(ARRAY['memory.correct']));
CREATE POLICY owner_advance ON owner_sequences FOR UPDATE TO unai_app
 USING(unai_private.has_owner_access(owner_scope_id) AND unai_private.memory_purpose(ARRAY['memory.correct']))
 WITH CHECK(unai_private.has_owner_access(owner_scope_id) AND unai_private.memory_purpose(ARRAY['memory.correct']));
GRANT SELECT,INSERT ON owner_sequences TO unai_app;
GRANT UPDATE(last_sequence,updated_at) ON owner_sequences TO unai_app;

ALTER TABLE owner_overlay_deltas ENABLE ROW LEVEL SECURITY;
ALTER TABLE owner_overlay_deltas FORCE ROW LEVEL SECURITY;
-- Every device of the owner reads the same rows under the same owner scope: that
-- is what makes the phone's acknowledged write visible to the desktop's next read
-- (CRT-RYW-02-A, CRT-RYW-02-B). The device and session columns are audit only and
-- never narrow this policy.
CREATE POLICY owner_read ON owner_overlay_deltas FOR SELECT TO unai_app
 USING(unai_private.has_owner_access(owner_scope_id)
 AND unai_private.memory_purpose(ARRAY['memory.correct','memory.govern','memory.read','memory.inspect','memory.canonicalize']));
CREATE POLICY owner_append ON owner_overlay_deltas FOR INSERT TO unai_app
 WITH CHECK(unai_private.has_owner_access(owner_scope_id) AND unai_private.memory_purpose(ARRAY['memory.correct']));
-- `memory.canonicalize` settles a delta too, because re-extraction is the path
-- that contests one. What it may settle it *to* is the trigger's decision, not
-- this policy's: CONTESTED and the attachment columns, never a lifecycle that
-- needs the owner (CRT-MEM-15-A).
CREATE POLICY owner_settle ON owner_overlay_deltas FOR UPDATE TO unai_app
 USING(unai_private.has_owner_access(owner_scope_id) AND unai_private.memory_purpose(ARRAY['memory.correct','memory.govern','memory.canonicalize']))
 WITH CHECK(unai_private.has_owner_access(owner_scope_id) AND unai_private.memory_purpose(ARRAY['memory.correct','memory.govern','memory.canonicalize']));
GRANT SELECT,INSERT ON owner_overlay_deltas TO unai_app;
GRANT UPDATE(lifecycle,attached_frame_instance_id,attached_belief_slot_id,resolved_by_transaction_id,contested_reason,embedding_id)
 ON owner_overlay_deltas TO unai_app;

ALTER TABLE memory_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory_operations FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_read ON memory_operations FOR SELECT TO unai_app
 USING(unai_private.has_owner_access(owner_scope_id)
 AND unai_private.memory_purpose(ARRAY['memory.correct','memory.govern','memory.read','memory.inspect']));
CREATE POLICY owner_append ON memory_operations FOR INSERT TO unai_app
 WITH CHECK(unai_private.has_owner_access(owner_scope_id) AND unai_private.memory_purpose(ARRAY['memory.correct'])
 AND requested_by_actor_id=unai_private.actor_id());
GRANT SELECT,INSERT ON memory_operations TO unai_app;

-- A memory operation is a statement about a moment: which control the owner used,
-- on what, and what it produced. Nothing about it is ever revised.
CREATE TRIGGER memory_operations_immutable BEFORE UPDATE ON memory_operations
 FOR EACH ROW EXECUTE FUNCTION unai_private.canonicalization_record_immutable();

-- CRT-MEM-15-A in the schema. Re-extraction may contest a user-confirmed
-- correction and no more: turning a CONTESTED delta into REJECTED_AS_INTERPRETATION
-- or SUPERSEDED requires the owner's own correction purpose, and the trigger binds
-- the privileged migration owner too. A user action arrives under `memory.correct`;
-- a re-extraction, running under `memory.canonicalize` or `memory.govern`, does not.
CREATE FUNCTION unai_private.overlay_delta_transition() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF NEW.owner_scope_id<>OLD.owner_scope_id OR NEW.owner_sequence<>OLD.owner_sequence
  OR NEW.delta_kind<>OLD.delta_kind OR NEW.raw_text<>OLD.raw_text
  OR NEW.source_evidence_id<>OLD.source_evidence_id OR NEW.created_at<>OLD.created_at
  OR NEW.target_object_type IS DISTINCT FROM OLD.target_object_type
  OR NEW.target_object_id IS DISTINCT FROM OLD.target_object_id THEN
  RAISE EXCEPTION 'OVERLAY_DELTA_IMMUTABLE' USING ERRCODE='55000';
 END IF;
 IF NEW.lifecycle IN ('REJECTED_AS_INTERPRETATION','SUPERSEDED','WITHDRAWN')
  AND OLD.lifecycle<>NEW.lifecycle
  AND current_setting('unai.purpose',true) IS DISTINCT FROM 'memory.correct' THEN
  RAISE EXCEPTION 'OVERLAY_DELTA_NEEDS_USER_ACTION' USING ERRCODE='55000';
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION unai_private.overlay_delta_transition() FROM PUBLIC;
CREATE TRIGGER owner_overlay_deltas_transition BEFORE UPDATE ON owner_overlay_deltas
 FOR EACH ROW EXECUTE FUNCTION unai_private.overlay_delta_transition();

-- The evidence half of the correction path. Each policy gains `memory.correct`
-- and keeps every other condition it already had, so the owner, the data purpose
-- and the sensitivity ceiling still decide as before.
DROP POLICY evidence_append ON source_items;
CREATE POLICY evidence_append ON source_items FOR INSERT TO unai_app
 WITH CHECK(unai_private.has_owner_access(owner_scope_id) AND submitted_by_user_id=unai_private.actor_id()
 AND current_setting('unai.purpose',true) IN ('evidence.ingest','memory.correct')
 AND unai_private.evidence_access(allowed_purposes,sensitivity));

DROP POLICY receipt_append ON evidence_ingestion_receipts;
CREATE POLICY receipt_append ON evidence_ingestion_receipts FOR INSERT TO unai_app
 WITH CHECK(unai_private.has_owner_access(owner_scope_id)
 AND current_setting('unai.purpose',true) IN ('evidence.ingest','memory.correct')
 AND EXISTS(SELECT 1 FROM source_items s WHERE s.owner_scope_id=evidence_ingestion_receipts.owner_scope_id AND s.id=source_item_id));

DROP POLICY object_key_append ON evidence_object_keys;
CREATE POLICY object_key_append ON evidence_object_keys FOR INSERT TO unai_app
 WITH CHECK(unai_private.has_owner_access(owner_scope_id)
 AND current_setting('unai.purpose',true) IN ('evidence.ingest','memory.correct')
 AND EXISTS(SELECT 1 FROM source_items s WHERE s.owner_scope_id=evidence_object_keys.owner_scope_id AND s.id=source_item_id));

DROP POLICY anchor_append ON source_anchors;
CREATE POLICY anchor_append ON source_anchors FOR INSERT TO unai_app
 WITH CHECK(unai_private.has_owner_access(owner_scope_id)
 AND current_setting('unai.purpose',true) IN ('evidence.ingest','memory.correct')
 AND EXISTS(SELECT 1 FROM source_items s WHERE s.owner_scope_id=source_anchors.owner_scope_id AND s.id=source_item_id));

DROP POLICY owner_append ON triage_decisions;
CREATE POLICY owner_append ON triage_decisions FOR INSERT TO unai_app
 WITH CHECK(unai_private.has_owner_access(owner_scope_id)
 AND unai_private.extraction_purpose(ARRAY['evidence.ingest','memory.correct'])
 AND EXISTS(SELECT 1 FROM source_items s WHERE s.owner_scope_id=triage_decisions.owner_scope_id AND s.id=source_item_id));
DROP POLICY owner_read ON triage_decisions;
CREATE POLICY owner_read ON triage_decisions FOR SELECT TO unai_app
 USING(unai_private.has_owner_access(owner_scope_id)
 AND unai_private.extraction_purpose(ARRAY['evidence.read','evidence.ingest','memory.extract','memory.canonicalize','memory.correct'])
 AND EXISTS(SELECT 1 FROM source_items s WHERE s.owner_scope_id=triage_decisions.owner_scope_id AND s.id=source_item_id));

-- The canonical half. The correction path reads the object it is about, records
-- the USER_CONFIRMATION claim of CRT-AI-03-A, and proposes a belief transaction;
-- it accepts nothing, so no assessment, support or slot write is opened to it.
DROP POLICY owner_read ON frame_instances;
CREATE POLICY owner_read ON frame_instances FOR SELECT TO unai_app
 USING(unai_private.has_owner_access(owner_scope_id)
 AND unai_private.memory_purpose(ARRAY['memory.canonicalize','memory.govern','memory.inspect','memory.correct']));
DROP POLICY owner_read ON belief_slots;
CREATE POLICY owner_read ON belief_slots FOR SELECT TO unai_app
 USING(unai_private.has_owner_access(owner_scope_id)
 AND unai_private.memory_purpose(ARRAY['memory.canonicalize','memory.govern','memory.inspect','memory.correct']));
DROP POLICY owner_read ON propositions;
CREATE POLICY owner_read ON propositions FOR SELECT TO unai_app
 USING(unai_private.has_owner_access(owner_scope_id)
 AND unai_private.memory_purpose(ARRAY['memory.canonicalize','memory.govern','memory.inspect','memory.correct']));
DROP POLICY owner_read ON claims;
CREATE POLICY owner_read ON claims FOR SELECT TO unai_app
 USING(unai_private.has_owner_access(owner_scope_id)
 AND unai_private.memory_purpose(ARRAY['memory.canonicalize','memory.govern','memory.inspect','memory.correct']));
DROP POLICY owner_append ON claims;
CREATE POLICY owner_append ON claims FOR INSERT TO unai_app
 WITH CHECK(unai_private.has_owner_access(owner_scope_id)
 AND unai_private.memory_purpose(ARRAY['memory.canonicalize','memory.govern','memory.correct']));
DROP POLICY owner_read ON belief_assessments;
CREATE POLICY owner_read ON belief_assessments FOR SELECT TO unai_app
 USING(unai_private.has_owner_access(owner_scope_id)
 AND unai_private.memory_purpose(ARRAY['memory.govern','memory.canonicalize','memory.inspect','memory.correct']));

DROP POLICY owner_read ON belief_transactions;
CREATE POLICY owner_read ON belief_transactions FOR SELECT TO unai_app
 USING(unai_private.has_owner_access(owner_scope_id)
 AND unai_private.memory_purpose(ARRAY['memory.govern','memory.inspect','memory.correct']));
DROP POLICY owner_propose ON belief_transactions;
CREATE POLICY owner_propose ON belief_transactions FOR INSERT TO unai_app
 WITH CHECK(unai_private.has_owner_access(owner_scope_id)
 AND unai_private.memory_purpose(ARRAY['memory.govern','memory.correct'])
 AND requested_by_actor_id=unai_private.actor_id());
DROP POLICY owner_read ON belief_transaction_operations;
CREATE POLICY owner_read ON belief_transaction_operations FOR SELECT TO unai_app
 USING(unai_private.has_owner_access(owner_scope_id)
 AND unai_private.memory_purpose(ARRAY['memory.govern','memory.inspect','memory.correct'])
 AND EXISTS(SELECT 1 FROM belief_transactions t WHERE t.owner_scope_id=belief_transaction_operations.owner_scope_id AND t.id=belief_transaction_id));
DROP POLICY owner_propose ON belief_transaction_operations;
CREATE POLICY owner_propose ON belief_transaction_operations FOR INSERT TO unai_app
 WITH CHECK(unai_private.has_owner_access(owner_scope_id)
 AND unai_private.memory_purpose(ARRAY['memory.govern','memory.correct'])
 AND EXISTS(SELECT 1 FROM belief_transactions t WHERE t.owner_scope_id=belief_transaction_operations.owner_scope_id AND t.id=belief_transaction_id));
