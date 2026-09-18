-- Typed projections and their rebuild receipts (design entities
-- `open_commitments_projection`, `obligations_projection`, `schedule_projection`
-- and `projection_rebuild_receipts`; PRD §25.3, §25.4, §33.12). ADR 0021 records
-- the decisions below before the code.
--
-- A projection is a derived, rebuildable view over canonical memory. It is never
-- a second truth store (PRD §25.2), which is why nothing here is referenced by a
-- claim, a proposition or a resolution assertion, and why every row carries the
-- inputs it was built from rather than a private opinion of its own.
--
-- Four rules are carried by the schema rather than by convention:
--
--  1. Query-critical values are typed columns (CRT-PRJ-01-A). Amount is
--     `numeric`, currency is a checked ISO 4217 code, due time and start/end are
--     `timestamptz`. `source_manifest` is the only JSONB here and it holds
--     provenance, never a value a reader has to parse to answer a question.
--  2. Every row states what it was built from and how far it got (CRT-PRJ-03-A).
--     `owner_scope_id`, the canonical source frame id, `projection_version`,
--     `canonical_transaction_watermark`, `owner_overlay_watermark`,
--     `reducer_version`, `is_complete`, `source_manifest` and `updated_at` are
--     all NOT NULL on all three tables, so an incomplete row is a row that says
--     it is incomplete rather than a row that is silently short.
--  3. The source frame is the identity. The primary key is
--     (owner_scope_id, <source frame instance id>), so a reducer can only ever
--     restate the row for a frame -- it cannot accumulate two readings of one
--     situation, and a full replay lands on exactly the rows an incremental
--     apply did (CRT-PRJ-02-A).
--  4. No arithmetic and no outcome live here. `total_canonical_allocation`,
--     `remaining_amount_capability_derived` and `unclassified_remainder` are
--     values the obligations capability computed from canonical
--     `finance.payment_allocation` frames and wrote down; `outcome_state` is the
--     derived reading of accepted resolution assertions. Neither is an input to
--     anything: a reader that wants either recomputes it (PRD §16.7, §25.2).

-- Why these tables may be DELETEd while no canonical table may be. PRD §25.4
-- requires every projection to be rebuildable, and CRT-PRJ-02-B drops and
-- rebuilds them outright. A row here is a cache of canonical memory, so removing
-- one destroys no belief, no evidence and no outcome -- the rebuild recreates it
-- from the same canonical rows. The canonical tables keep their append-only
-- grants unchanged.

CREATE TABLE open_commitments_projection (
 owner_scope_id uuid NOT NULL REFERENCES owner_scopes(id),
 -- Canonical source frame id (PRD §33.12). It is the row's identity.
 commitment_frame_instance_id uuid NOT NULL,
 promisor_entity_id uuid,
 promisee_entity_id uuid,
 action_description text CHECK(action_description IS NULL OR length(action_description) BETWEEN 1 AND 4096),
 due_time timestamptz,
 outcome_state text NOT NULL CHECK(outcome_state IN ('UNRESOLVED','PARTIALLY_RESOLVED','RESOLVED','CONTESTED')),
 -- Set by the clock and by nothing else (PRD §12.6, CRT-OUT-07-A). Passing a due
 -- time moves these two booleans and creates no resolution assertion anywhere.
 overdue boolean NOT NULL DEFAULT false,
 due_soon boolean NOT NULL DEFAULT false,
 source_strength text NOT NULL CHECK(source_strength IN ('NONE','MODEL_ONLY','OWNER_STATEMENT','PENDING_OWNER_ASSERTION','INDEPENDENTLY_CORROBORATED')),
 conflict_flag boolean NOT NULL DEFAULT false,
 overlay_complete boolean NOT NULL DEFAULT true,
 last_material_update timestamptz NOT NULL,
 projection_version uuid NOT NULL,
 canonical_transaction_watermark timestamptz NOT NULL,
 owner_overlay_watermark bigint NOT NULL CHECK(owner_overlay_watermark >= 0),
 reducer_version text NOT NULL CHECK(reducer_version ~ '^[a-z][a-z0-9_.-]{0,63}$'),
 is_complete boolean NOT NULL,
 source_manifest jsonb NOT NULL CHECK(jsonb_typeof(source_manifest)='object'),
 updated_at timestamptz NOT NULL,
 PRIMARY KEY(owner_scope_id,commitment_frame_instance_id),
 FOREIGN KEY(owner_scope_id,commitment_frame_instance_id) REFERENCES frame_instances(owner_scope_id,id),
 FOREIGN KEY(owner_scope_id,promisor_entity_id) REFERENCES entities(owner_scope_id,id),
 FOREIGN KEY(owner_scope_id,promisee_entity_id) REFERENCES entities(owner_scope_id,id)
);
-- Indexed for the reads the Commitments screen makes: this owner's open work by
-- due window, and one person's commitments (PRD §41 Performance).
CREATE INDEX open_commitments_projection_due ON open_commitments_projection(owner_scope_id,due_time,outcome_state);
CREATE INDEX open_commitments_projection_promisee ON open_commitments_projection(owner_scope_id,promisee_entity_id);
CREATE INDEX open_commitments_projection_incomplete ON open_commitments_projection(owner_scope_id,updated_at)
 WHERE is_complete=false;

CREATE TABLE obligations_projection (
 owner_scope_id uuid NOT NULL REFERENCES owner_scopes(id),
 obligation_frame_instance_id uuid NOT NULL,
 debtor_entity_id uuid,
 creditor_entity_id uuid,
 -- Typed money, never JSONB alone (PRD §33.12, CRT-PRJ-01-A). The kernel does no
 -- arithmetic over these; the obligations capability computed them.
 principal_amount numeric CHECK(principal_amount IS NULL OR principal_amount >= 0),
 currency text CHECK(currency IS NULL OR currency ~ '^[A-Z]{3}$'),
 due_time timestamptz,
 total_canonical_allocation numeric NOT NULL DEFAULT 0 CHECK(total_canonical_allocation >= 0),
 remaining_amount_capability_derived numeric,
 -- Null means "not known", which is the only honest answer for a payment whose
 -- surplus nobody has classified yet (PRD §26.4, §44.1).
 unclassified_remainder numeric CHECK(unclassified_remainder IS NULL OR unclassified_remainder >= 0),
 outcome_state text NOT NULL CHECK(outcome_state IN ('UNRESOLVED','PARTIALLY_RESOLVED','RESOLVED','CONTESTED')),
 conflict_flag boolean NOT NULL DEFAULT false,
 overlay_complete boolean NOT NULL DEFAULT true,
 projection_version uuid NOT NULL,
 canonical_transaction_watermark timestamptz NOT NULL,
 owner_overlay_watermark bigint NOT NULL CHECK(owner_overlay_watermark >= 0),
 reducer_version text NOT NULL CHECK(reducer_version ~ '^[a-z][a-z0-9_.-]{0,63}$'),
 is_complete boolean NOT NULL,
 source_manifest jsonb NOT NULL CHECK(jsonb_typeof(source_manifest)='object'),
 updated_at timestamptz NOT NULL,
 PRIMARY KEY(owner_scope_id,obligation_frame_instance_id),
 FOREIGN KEY(owner_scope_id,obligation_frame_instance_id) REFERENCES frame_instances(owner_scope_id,id),
 FOREIGN KEY(owner_scope_id,debtor_entity_id) REFERENCES entities(owner_scope_id,id),
 FOREIGN KEY(owner_scope_id,creditor_entity_id) REFERENCES entities(owner_scope_id,id),
 -- An amount without its currency is not a money value (PRD §26.1).
 CONSTRAINT obligations_projection_money_paired CHECK((principal_amount IS NULL)=(currency IS NULL))
);
CREATE INDEX obligations_projection_due ON obligations_projection(owner_scope_id,due_time,outcome_state);
CREATE INDEX obligations_projection_creditor ON obligations_projection(owner_scope_id,creditor_entity_id);
CREATE INDEX obligations_projection_incomplete ON obligations_projection(owner_scope_id,updated_at)
 WHERE is_complete=false;

CREATE TABLE schedule_projection (
 owner_scope_id uuid NOT NULL REFERENCES owner_scopes(id),
 scheduled_frame_instance_id uuid NOT NULL,
 start_time timestamptz,
 end_time timestamptz,
 recurrence_instance_id text CHECK(recurrence_instance_id IS NULL OR length(recurrence_instance_id) BETWEEN 1 AND 512),
 participants uuid[] NOT NULL DEFAULT '{}',
 -- The REALIZES link, when an actual occurrence has been recorded, and the
 -- accepted resolution, when one exists. Both null is the ordinary state of a
 -- calendar event whose date has passed: time proves nothing (PRD §44.7).
 realization_link_id uuid,
 outcome_resolution_id uuid,
 preparation_requirement text CHECK(preparation_requirement IS NULL OR length(preparation_requirement) BETWEEN 1 AND 2048),
 projection_version uuid NOT NULL,
 canonical_transaction_watermark timestamptz NOT NULL,
 owner_overlay_watermark bigint NOT NULL CHECK(owner_overlay_watermark >= 0),
 reducer_version text NOT NULL CHECK(reducer_version ~ '^[a-z][a-z0-9_.-]{0,63}$'),
 is_complete boolean NOT NULL,
 source_manifest jsonb NOT NULL CHECK(jsonb_typeof(source_manifest)='object'),
 updated_at timestamptz NOT NULL,
 PRIMARY KEY(owner_scope_id,scheduled_frame_instance_id),
 FOREIGN KEY(owner_scope_id,scheduled_frame_instance_id) REFERENCES frame_instances(owner_scope_id,id),
 FOREIGN KEY(owner_scope_id,realization_link_id) REFERENCES memory_links(owner_scope_id,id),
 FOREIGN KEY(owner_scope_id,outcome_resolution_id) REFERENCES resolution_assertions(owner_scope_id,id),
 CONSTRAINT schedule_projection_interval CHECK(end_time IS NULL OR start_time IS NULL OR start_time <= end_time)
);
CREATE INDEX schedule_projection_window ON schedule_projection(owner_scope_id,start_time,end_time);
CREATE INDEX schedule_projection_incomplete ON schedule_projection(owner_scope_id,updated_at)
 WHERE is_complete=false;

-- What a rebuild did, and whether the replayed rows equalled the incrementally
-- maintained ones (design entity `projection_rebuild_receipts`; PRD §25.4, §49).
-- Append-only: a receipt is evidence about a run and is never restated.
CREATE TABLE projection_rebuild_receipts (
 id uuid PRIMARY KEY,
 owner_scope_id uuid NOT NULL REFERENCES owner_scopes(id),
 projection_name text NOT NULL CHECK(projection_name IN ('open_commitments_projection','obligations_projection','schedule_projection')),
 trigger text NOT NULL CHECK(trigger IN ('MERGE','SPLIT','MIGRATION','MANUAL_REPLAY','DROP_AND_REBUILD','INCREMENTAL_APPLY')),
 transaction_id uuid,
 rows_rebuilt integer NOT NULL CHECK(rows_rebuilt >= 0),
 -- Null when the run did not compare itself with an incremental state; false is
 -- a real finding and must never be written as null to hide it.
 equals_incremental boolean,
 projection_version uuid NOT NULL,
 reducer_version text NOT NULL CHECK(reducer_version ~ '^[a-z][a-z0-9_.-]{0,63}$'),
 detail jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(detail)='object'),
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(owner_scope_id,id),
 FOREIGN KEY(owner_scope_id,transaction_id) REFERENCES belief_transactions(owner_scope_id,id)
);
CREATE INDEX projection_rebuild_receipts_recent ON projection_rebuild_receipts(owner_scope_id,projection_name,created_at DESC);

-- Purposes. `memory.project` is the reducer's: it is the only purpose that may
-- write a projection row, and a session holding it is running a capability, not
-- answering a user. `projection.read` is the read purpose behind
-- GET /v1/projections/*, and `memory.inspect` and `memory.govern` read too so the
-- Memory inspector and a governed merge see the same rows without a second
-- session.
ALTER TABLE open_commitments_projection ENABLE ROW LEVEL SECURITY;
ALTER TABLE open_commitments_projection FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_read ON open_commitments_projection FOR SELECT TO unai_app
 USING(unai_private.has_owner_access(owner_scope_id)
 AND unai_private.memory_purpose(ARRAY['memory.project','projection.read','memory.inspect','memory.govern']));
CREATE POLICY owner_reduce ON open_commitments_projection FOR INSERT TO unai_app
 WITH CHECK(unai_private.has_owner_access(owner_scope_id) AND unai_private.memory_purpose(ARRAY['memory.project']));
CREATE POLICY owner_restate ON open_commitments_projection FOR UPDATE TO unai_app
 USING(unai_private.has_owner_access(owner_scope_id) AND unai_private.memory_purpose(ARRAY['memory.project']))
 WITH CHECK(unai_private.has_owner_access(owner_scope_id) AND unai_private.memory_purpose(ARRAY['memory.project']));
CREATE POLICY owner_rebuild ON open_commitments_projection FOR DELETE TO unai_app
 USING(unai_private.has_owner_access(owner_scope_id) AND unai_private.memory_purpose(ARRAY['memory.project']));
GRANT SELECT,INSERT,UPDATE,DELETE ON open_commitments_projection TO unai_app;

ALTER TABLE obligations_projection ENABLE ROW LEVEL SECURITY;
ALTER TABLE obligations_projection FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_read ON obligations_projection FOR SELECT TO unai_app
 USING(unai_private.has_owner_access(owner_scope_id)
 AND unai_private.memory_purpose(ARRAY['memory.project','projection.read','memory.inspect','memory.govern']));
CREATE POLICY owner_reduce ON obligations_projection FOR INSERT TO unai_app
 WITH CHECK(unai_private.has_owner_access(owner_scope_id) AND unai_private.memory_purpose(ARRAY['memory.project']));
CREATE POLICY owner_restate ON obligations_projection FOR UPDATE TO unai_app
 USING(unai_private.has_owner_access(owner_scope_id) AND unai_private.memory_purpose(ARRAY['memory.project']))
 WITH CHECK(unai_private.has_owner_access(owner_scope_id) AND unai_private.memory_purpose(ARRAY['memory.project']));
CREATE POLICY owner_rebuild ON obligations_projection FOR DELETE TO unai_app
 USING(unai_private.has_owner_access(owner_scope_id) AND unai_private.memory_purpose(ARRAY['memory.project']));
GRANT SELECT,INSERT,UPDATE,DELETE ON obligations_projection TO unai_app;

ALTER TABLE schedule_projection ENABLE ROW LEVEL SECURITY;
ALTER TABLE schedule_projection FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_read ON schedule_projection FOR SELECT TO unai_app
 USING(unai_private.has_owner_access(owner_scope_id)
 AND unai_private.memory_purpose(ARRAY['memory.project','projection.read','memory.inspect','memory.govern']));
CREATE POLICY owner_reduce ON schedule_projection FOR INSERT TO unai_app
 WITH CHECK(unai_private.has_owner_access(owner_scope_id) AND unai_private.memory_purpose(ARRAY['memory.project']));
CREATE POLICY owner_restate ON schedule_projection FOR UPDATE TO unai_app
 USING(unai_private.has_owner_access(owner_scope_id) AND unai_private.memory_purpose(ARRAY['memory.project']))
 WITH CHECK(unai_private.has_owner_access(owner_scope_id) AND unai_private.memory_purpose(ARRAY['memory.project']));
CREATE POLICY owner_rebuild ON schedule_projection FOR DELETE TO unai_app
 USING(unai_private.has_owner_access(owner_scope_id) AND unai_private.memory_purpose(ARRAY['memory.project']));
GRANT SELECT,INSERT,UPDATE,DELETE ON schedule_projection TO unai_app;

-- Receipts are append-only: no UPDATE and no DELETE grant, as `audit_events` has
-- none. The operations console reads them under `ops.projections.read`.
ALTER TABLE projection_rebuild_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE projection_rebuild_receipts FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_read ON projection_rebuild_receipts FOR SELECT TO unai_app
 USING(unai_private.has_owner_access(owner_scope_id)
 AND unai_private.memory_purpose(ARRAY['memory.project','projection.read','memory.inspect','memory.govern','ops.projections.read']));
CREATE POLICY owner_append ON projection_rebuild_receipts FOR INSERT TO unai_app
 WITH CHECK(unai_private.has_owner_access(owner_scope_id)
 AND unai_private.memory_purpose(ARRAY['memory.project','memory.govern']));
GRANT SELECT,INSERT ON projection_rebuild_receipts TO unai_app;

-- A projection row states what it was built from; changing which frame it speaks
-- about would make the manifest a lie. The trigger binds the privileged migration
-- owner too, so no data fix can re-point a row at another situation either.
CREATE FUNCTION unai_private.open_commitments_projection_identity() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF NEW.owner_scope_id<>OLD.owner_scope_id
  OR NEW.commitment_frame_instance_id<>OLD.commitment_frame_instance_id THEN
  RAISE EXCEPTION 'PROJECTION_IDENTITY_IMMUTABLE' USING ERRCODE='55000';
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION unai_private.open_commitments_projection_identity() FROM PUBLIC;
CREATE TRIGGER open_commitments_projection_identity BEFORE UPDATE ON open_commitments_projection
 FOR EACH ROW EXECUTE FUNCTION unai_private.open_commitments_projection_identity();

CREATE FUNCTION unai_private.obligations_projection_identity() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF NEW.owner_scope_id<>OLD.owner_scope_id
  OR NEW.obligation_frame_instance_id<>OLD.obligation_frame_instance_id THEN
  RAISE EXCEPTION 'PROJECTION_IDENTITY_IMMUTABLE' USING ERRCODE='55000';
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION unai_private.obligations_projection_identity() FROM PUBLIC;
CREATE TRIGGER obligations_projection_identity BEFORE UPDATE ON obligations_projection
 FOR EACH ROW EXECUTE FUNCTION unai_private.obligations_projection_identity();

CREATE FUNCTION unai_private.schedule_projection_identity() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF NEW.owner_scope_id<>OLD.owner_scope_id
  OR NEW.scheduled_frame_instance_id<>OLD.scheduled_frame_instance_id THEN
  RAISE EXCEPTION 'PROJECTION_IDENTITY_IMMUTABLE' USING ERRCODE='55000';
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION unai_private.schedule_projection_identity() FROM PUBLIC;
CREATE TRIGGER schedule_projection_identity BEFORE UPDATE ON schedule_projection
 FOR EACH ROW EXECUTE FUNCTION unai_private.schedule_projection_identity();

-- What `memory.project` may read.
--
-- A reducer is the one principal that must read across the whole of canonical
-- memory for an owner and may write nothing of it. The SELECT policies below gain
-- exactly that purpose and nothing else changes: no INSERT, UPDATE or DELETE
-- policy anywhere admits `memory.project`, so a capability holding it can restate
-- a projection row and can never touch a frame, a slot, a proposition, a claim, a
-- link, a resolution assertion or an overlay delta. Each policy is reproduced
-- whole with its existing predicate, because a policy is replaced and not
-- amended.
DROP POLICY owner_read ON frame_instances;
CREATE POLICY owner_read ON frame_instances FOR SELECT TO unai_app
 USING(unai_private.has_owner_access(owner_scope_id)
 AND unai_private.memory_purpose(ARRAY['memory.canonicalize','memory.govern','memory.inspect','memory.correct','memory.project']));
DROP POLICY owner_read ON frame_instance_roles;
CREATE POLICY owner_read ON frame_instance_roles FOR SELECT TO unai_app
 USING(unai_private.has_owner_access(owner_scope_id)
 AND unai_private.memory_purpose(ARRAY['memory.canonicalize','memory.govern','memory.inspect','memory.project'])
 AND EXISTS(SELECT 1 FROM frame_instances f WHERE f.owner_scope_id=frame_instance_roles.owner_scope_id AND f.id=frame_instance_id));
DROP POLICY owner_read ON belief_slots;
CREATE POLICY owner_read ON belief_slots FOR SELECT TO unai_app
 USING(unai_private.has_owner_access(owner_scope_id)
 AND unai_private.memory_purpose(ARRAY['memory.canonicalize','memory.govern','memory.inspect','memory.correct','memory.project']));
DROP POLICY owner_read ON propositions;
CREATE POLICY owner_read ON propositions FOR SELECT TO unai_app
 USING(unai_private.has_owner_access(owner_scope_id)
 AND unai_private.memory_purpose(ARRAY['memory.canonicalize','memory.govern','memory.inspect','memory.correct','memory.project']));
DROP POLICY owner_read ON claims;
CREATE POLICY owner_read ON claims FOR SELECT TO unai_app
 USING(unai_private.has_owner_access(owner_scope_id)
 AND unai_private.memory_purpose(ARRAY['memory.canonicalize','memory.govern','memory.inspect','memory.correct','memory.project']));
DROP POLICY owner_read ON entities;
CREATE POLICY owner_read ON entities FOR SELECT TO unai_app
 USING(unai_private.has_owner_access(owner_scope_id)
 AND unai_private.memory_purpose(ARRAY['memory.canonicalize','memory.govern','memory.inspect','memory.project']));
DROP POLICY owner_read ON memory_links;
CREATE POLICY owner_read ON memory_links FOR SELECT TO unai_app
 USING(unai_private.has_owner_access(owner_scope_id)
 AND unai_private.memory_purpose(ARRAY['memory.canonicalize','memory.govern','memory.inspect','memory.correct','memory.project']));
DROP POLICY owner_read ON resolution_assertions;
CREATE POLICY owner_read ON resolution_assertions FOR SELECT TO unai_app
 USING(unai_private.has_owner_access(owner_scope_id)
 AND unai_private.memory_purpose(ARRAY['memory.canonicalize','memory.govern','memory.inspect','memory.correct','memory.project']));
DROP POLICY owner_read ON owner_overlay_deltas;
CREATE POLICY owner_read ON owner_overlay_deltas FOR SELECT TO unai_app
 USING(unai_private.has_owner_access(owner_scope_id)
 AND unai_private.memory_purpose(ARRAY['memory.correct','memory.govern','memory.read','memory.inspect','memory.canonicalize','memory.project']));
DROP POLICY owner_read ON belief_transactions;
CREATE POLICY owner_read ON belief_transactions FOR SELECT TO unai_app
 USING(unai_private.has_owner_access(owner_scope_id)
 AND unai_private.memory_purpose(ARRAY['memory.govern','memory.inspect','memory.correct','memory.project']));

-- ...and what `projection.read` may read beyond the projection rows themselves.
--
-- A projection read has to show the owner's pending writes: a correction made on
-- another device belongs in *this* answer, and one the reducer could not fold in
-- has to come back beside the persisted row rather than disappear from it
-- (CRT-RYW-02-A, CRT-RYW-04-A). The overlay is therefore readable under the
-- read purpose. Nothing else is: `projection.read` sees no frame, slot,
-- proposition, claim or belief transaction, so the read answers from the
-- projection and the overlay and from nowhere else.
DROP POLICY owner_read ON owner_overlay_deltas;
CREATE POLICY owner_read ON owner_overlay_deltas FOR SELECT TO unai_app
 USING(unai_private.has_owner_access(owner_scope_id)
 AND unai_private.memory_purpose(ARRAY['memory.correct','memory.govern','memory.read','memory.inspect',
   'memory.canonicalize','memory.project','projection.read']));
