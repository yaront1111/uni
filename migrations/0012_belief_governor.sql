-- The write governor: belief transactions and their ordered operations, the
-- append-only belief assessment history, the support graph with its independence
-- groups, the derived-proposition dependency record, and the persisted policy
-- decisions of the three local ports (design entities `belief_transactions`,
-- `belief_transaction_operations`, `belief_assessments`, `belief_support`,
-- `derived_proposition_dependencies`, `policy_decisions`; PRD §19, §29.3, §33.7,
-- §33.9). ADR 0017 records the decisions below before the code.
--
-- Five invariants are carried by the schema rather than by convention:
--
--  1. Nothing accepts a belief outside a transaction. `belief_assessments` and
--     `belief_support` both require a `transaction_id`, so an accepted belief
--     with no governed transaction behind it is unrepresentable (PRD §19.1).
--  2. An assessment is append-only. No column but `superseded_recorded_at` may
--     ever move, and only once, from NULL to a time (CRT-AI-02-A's UNSUPPORTED
--     transition appends a row; it never rewrites the earlier verdict).
--  3. A support row names exactly one supporter, and never itself. The
--     one-step cycle is a CHECK; the multi-step cycle is rejected at validate
--     and commit, which is application work (CRT-MEM-12-B).
--  4. Committing twice answers once. `idempotency_key` is unique per owner scope
--     and the receipt is stored on the row, so the second commit returns the
--     bytes the first one wrote rather than recomputing them (CRT-WRT-02-B).
--  5. A context move is governed. Moving a belief slot between context spaces
--     requires a belief transaction that is committing in this very transaction,
--     enforced by a trigger that binds the privileged principal too
--     (CRT-REG-06-B).

-- One proposed change set over canonical memory (PRD §33.9). `registry_release_id`
-- is the release the whole transaction is pinned to; it carries no foreign key for
-- the reason ADR 0015 §2 and ADR 0016 §3 already recorded -- `registry_releases`
-- is the global immutable snapshot of ADR 0011, and an owner-scoped reference
-- would preempt its own truncation guard. Presence of a contract inside that
-- release is answered by the reviewed definer reader below, never by a join.
CREATE TABLE belief_transactions (
 id uuid PRIMARY KEY,
 owner_scope_id uuid NOT NULL REFERENCES owner_scopes(id),
 transaction_kind text NOT NULL CHECK(transaction_kind IN ('CANONICALIZE','CORRECT','STATE_CHANGE','CONFIRM','REJECT','DERIVE','MERGE','SPLIT','SUPPRESS','ARCHIVE','DELETE','RESOLVE')),
 requested_by_actor_id uuid NOT NULL,
 source_evidence_ids uuid[] NOT NULL DEFAULT '{}',
 registry_release_id uuid NOT NULL,
 status text NOT NULL DEFAULT 'PROPOSED' CHECK(status IN ('PROPOSED','VALIDATED','COMMITTING','COMMITTED','REJECTED')),
 risk text NOT NULL CHECK(risk IN ('LOW','MEDIUM','HIGH')),
 admission_mode text CHECK(admission_mode IN ('SOURCE_ONLY','INDEX_ONLY','AUTO_CLAIM','AUTO_ACCEPT','AUTO_PROVISIONAL','BATCH_REVIEW','JUST_IN_TIME')),
 policy_decision jsonb CHECK(policy_decision IS NULL OR jsonb_typeof(policy_decision)='object'),
 policy_decision_id uuid,
 validation jsonb CHECK(validation IS NULL OR jsonb_typeof(validation)='object'),
 commit_receipt jsonb CHECK(commit_receipt IS NULL OR jsonb_typeof(commit_receipt)='object'),
 rejection_reason jsonb CHECK(rejection_reason IS NULL OR jsonb_typeof(rejection_reason)='object'),
 idempotency_key text NOT NULL CHECK(idempotency_key ~ '^[a-zA-Z0-9_-]{16,128}$'),
 proposed_at timestamptz NOT NULL DEFAULT now(),
 committed_at timestamptz,
 rejected_at timestamptz,
 UNIQUE(owner_scope_id,id),
 -- One proposal per key per owner: a retried propose finds the first transaction
 -- rather than opening a second one over the same intent (CRT-WRT-02-B).
 UNIQUE(owner_scope_id,idempotency_key),
 FOREIGN KEY(owner_scope_id,requested_by_actor_id) REFERENCES owner_scope_members(owner_scope_id,user_id),
 CONSTRAINT belief_transactions_commit_recorded CHECK((status='COMMITTED')=(committed_at IS NOT NULL)),
 CONSTRAINT belief_transactions_rejection_recorded CHECK((status='REJECTED')=(rejected_at IS NOT NULL)),
 -- A committed transaction always carries the receipt it answered with, so a
 -- repeat commit has something byte-identical to return.
 CONSTRAINT belief_transactions_receipt_recorded CHECK((status='COMMITTED')=(commit_receipt IS NOT NULL))
);
CREATE INDEX belief_transactions_owner ON belief_transactions(owner_scope_id,status,proposed_at);

-- The ordered operations of one transaction. `operation_order` is unique inside
-- the transaction, so the commit path replays exactly the sequence that was
-- proposed and a failure at order N leaves orders 1..N-1 invisible with it
-- (CRT-WRT-02-A).
CREATE TABLE belief_transaction_operations (
 id uuid PRIMARY KEY,
 owner_scope_id uuid NOT NULL REFERENCES owner_scopes(id),
 belief_transaction_id uuid NOT NULL,
 operation_order integer NOT NULL CHECK(operation_order >= 0),
 operation_kind text NOT NULL CHECK(operation_kind IN ('CREATE_FRAME_INSTANCE','CREATE_SLOT','CREATE_PROPOSITION','ADD_CLAIM','ADD_SUPPORT','SET_BELIEF_ASSESSMENT','DERIVE','QUALIFY','MERGE','SPLIT','SUPPRESS','ARCHIVE','DELETE')),
 payload jsonb NOT NULL CHECK(jsonb_typeof(payload)='object'),
 result_object_refs jsonb CHECK(result_object_refs IS NULL OR jsonb_typeof(result_object_refs)='object'),
 UNIQUE(owner_scope_id,id),
 UNIQUE(owner_scope_id,belief_transaction_id,operation_order),
 FOREIGN KEY(owner_scope_id,belief_transaction_id) REFERENCES belief_transactions(owner_scope_id,id)
);
CREATE INDEX belief_transaction_operations_order ON belief_transaction_operations(owner_scope_id,belief_transaction_id,operation_order);

-- What the kernel believes about one proposition, as a recorded-time version
-- (PRD §33.7). Append-only: a new verdict is a new row, and the only column that
-- ever moves on an existing row is `superseded_recorded_at`.
CREATE TABLE belief_assessments (
 id uuid PRIMARY KEY,
 owner_scope_id uuid NOT NULL REFERENCES owner_scopes(id),
 proposition_id uuid NOT NULL,
 assessment_status text NOT NULL CHECK(assessment_status IN ('CANDIDATE','PROVISIONAL','ACCEPTED','CONTESTED','REJECTED','SUPERSEDED','UNSUPPORTED','SUPPRESSED')),
 valid_from timestamptz,
 valid_to timestamptz,
 recorded_at timestamptz NOT NULL DEFAULT now(),
 superseded_recorded_at timestamptz,
 policy_version text NOT NULL CHECK(policy_version ~ '^[a-z][a-z0-9_.-]{0,63}$'),
 decision_reason jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(decision_reason)='object'),
 transaction_id uuid NOT NULL,
 UNIQUE(owner_scope_id,id),
 FOREIGN KEY(owner_scope_id,proposition_id) REFERENCES propositions(owner_scope_id,id),
 FOREIGN KEY(owner_scope_id,transaction_id) REFERENCES belief_transactions(owner_scope_id,id),
 CONSTRAINT belief_assessments_interval CHECK(valid_to IS NULL OR valid_from IS NULL OR valid_from <= valid_to),
 CONSTRAINT belief_assessments_supersession_ordered CHECK(superseded_recorded_at IS NULL OR superseded_recorded_at >= recorded_at)
);
CREATE INDEX belief_assessments_proposition ON belief_assessments(owner_scope_id,proposition_id,recorded_at);
-- At most one live verdict per proposition: the current belief is a lookup, not a scan.
CREATE UNIQUE INDEX belief_assessments_live ON belief_assessments(owner_scope_id,proposition_id)
 WHERE superseded_recorded_at IS NULL;

-- What a proposition rests on (PRD §33.7, §15.4). A row names exactly one
-- supporter -- a claim or another proposition -- and carries the independence
-- group the write governor computed for it. Repetition is not independence: three
-- messages from one party, the quoted history of that party inside a later
-- message, and a model summary of it all share one group.
CREATE TABLE belief_support (
 id uuid PRIMARY KEY,
 owner_scope_id uuid NOT NULL REFERENCES owner_scopes(id),
 proposition_id uuid NOT NULL,
 claim_id uuid,
 supporting_proposition_id uuid,
 support_kind text NOT NULL CHECK(support_kind IN ('DIRECT_ASSERTION','CORROBORATION','DERIVATION','QUOTED_RESTATEMENT','MODEL_SUMMARY','STRUCTURED_OBSERVATION','USER_CONFIRMATION')),
 independence_group text CHECK(independence_group ~ '^[a-z0-9][a-z0-9_.:-]{0,127}$'),
 created_by_transaction_id uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(owner_scope_id,id),
 FOREIGN KEY(owner_scope_id,proposition_id) REFERENCES propositions(owner_scope_id,id),
 FOREIGN KEY(owner_scope_id,claim_id) REFERENCES claims(owner_scope_id,id),
 FOREIGN KEY(owner_scope_id,supporting_proposition_id) REFERENCES propositions(owner_scope_id,id),
 FOREIGN KEY(owner_scope_id,created_by_transaction_id) REFERENCES belief_transactions(owner_scope_id,id),
 CONSTRAINT belief_support_names_one_supporter CHECK(num_nonnulls(claim_id,supporting_proposition_id)=1),
 -- The one-step cycle is unrepresentable here; longer ones are rejected at
 -- validate and commit, where the whole graph is reachable (CRT-MEM-12-B).
 CONSTRAINT belief_support_not_self CHECK(supporting_proposition_id IS DISTINCT FROM proposition_id)
);
CREATE INDEX belief_support_proposition ON belief_support(owner_scope_id,proposition_id);
CREATE INDEX belief_support_supporting ON belief_support(owner_scope_id,supporting_proposition_id);
CREATE INDEX belief_support_claim ON belief_support(owner_scope_id,claim_id);

-- How a derived proposition was computed (PRD §33.7, CRT-AI-02-A). Inputs,
-- evaluator, the code or model version that ran, the pinned release and the
-- calculation inputs are all required, so a derived belief whose derivation
-- cannot be re-read is unrepresentable. When every input is invalidated the
-- assessment engine appends UNSUPPORTED for the derived proposition.
CREATE TABLE derived_proposition_dependencies (
 id uuid PRIMARY KEY,
 owner_scope_id uuid NOT NULL REFERENCES owner_scopes(id),
 derived_proposition_id uuid NOT NULL,
 input_claim_ids uuid[] NOT NULL DEFAULT '{}',
 input_proposition_ids uuid[] NOT NULL DEFAULT '{}',
 evaluator_id text NOT NULL CHECK(evaluator_id ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
 model_or_code_version text NOT NULL CHECK(model_or_code_version ~ '^[a-z0-9][a-z0-9_.-]{0,63}$'),
 registry_release_id uuid NOT NULL,
 calculation_inputs jsonb NOT NULL CHECK(jsonb_typeof(calculation_inputs)='object'),
 created_by_transaction_id uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(owner_scope_id,id),
 FOREIGN KEY(owner_scope_id,derived_proposition_id) REFERENCES propositions(owner_scope_id,id),
 FOREIGN KEY(owner_scope_id,created_by_transaction_id) REFERENCES belief_transactions(owner_scope_id,id),
 -- A derivation from nothing is not a derivation.
 CONSTRAINT derived_proposition_dependencies_has_inputs
  CHECK(cardinality(input_claim_ids)+cardinality(input_proposition_ids) > 0)
);
CREATE INDEX derived_proposition_dependencies_derived ON derived_proposition_dependencies(owner_scope_id,derived_proposition_id);
CREATE INDEX derived_proposition_dependencies_claims ON derived_proposition_dependencies USING gin(input_claim_ids);
CREATE INDEX derived_proposition_dependencies_propositions ON derived_proposition_dependencies USING gin(input_proposition_ids);

-- Every decision the three local policy ports reached, persisted for audit
-- (PRD §29.3). The outcome vocabulary is per port: a read may be redacted and a
-- write may be staged, and neither may borrow the other's answer.
CREATE TABLE policy_decisions (
 id uuid PRIMARY KEY,
 owner_scope_id uuid NOT NULL REFERENCES owner_scopes(id),
 port text NOT NULL CHECK(port IN ('EvaluateMemoryWrite','EvaluateMemoryRead','EvaluateMemoryAction')),
 request jsonb NOT NULL CHECK(jsonb_typeof(request)='object'),
 outcome text NOT NULL CHECK(outcome IN ('ALLOW','STAGE','REQUIRE_CONFIRMATION','REDACT','DENY')),
 required_confirmation boolean NOT NULL DEFAULT false,
 redactions jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(redactions)='array'),
 obligations jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(obligations)='array'),
 expiry timestamptz,
 reason text NOT NULL CHECK(reason ~ '^[A-Z][A-Z0-9_]{0,63}$'),
 policy_version text NOT NULL CHECK(policy_version ~ '^[a-z][a-z0-9_.-]{0,63}$'),
 subject_transaction_id uuid,
 correlation_id uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(owner_scope_id,id),
 FOREIGN KEY(owner_scope_id,subject_transaction_id) REFERENCES belief_transactions(owner_scope_id,id),
 CONSTRAINT policy_decisions_outcome_fits_port CHECK(
  (port='EvaluateMemoryWrite' AND outcome IN ('ALLOW','STAGE','REQUIRE_CONFIRMATION','DENY'))
  OR (port='EvaluateMemoryRead' AND outcome IN ('ALLOW','REDACT','DENY'))
  OR (port='EvaluateMemoryAction' AND outcome IN ('ALLOW','REQUIRE_CONFIRMATION','DENY'))),
 CONSTRAINT policy_decisions_confirmation_matches_outcome
  CHECK(required_confirmation = (outcome='REQUIRE_CONFIRMATION'))
);
CREATE INDEX policy_decisions_owner ON policy_decisions(owner_scope_id,port,created_at);
CREATE INDEX policy_decisions_subject ON policy_decisions(owner_scope_id,subject_transaction_id);

ALTER TABLE belief_transactions ADD CONSTRAINT belief_transactions_policy_decision
 FOREIGN KEY(owner_scope_id,policy_decision_id) REFERENCES policy_decisions(owner_scope_id,id);

-- The reviewed presence reader for the pinned release (ADR 0017 §1). The registry
-- snapshot keeps forced RLS, no policy and no application privilege, exactly as
-- ADR 0011 and ADR 0014 left it; this definer function answers one boolean and
-- returns no contract id, version, body or hash, so an unregistered predicate is
-- refused without the application ever reading the registry. It fails closed
-- without an owner context or under an unrelated purpose.
CREATE FUNCTION unai_private.registry_contract_present(release_id uuid, contract text, kind text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT unai_private.owner_id() IS NOT NULL
  AND current_setting('unai.purpose',true) = ANY(ARRAY['memory.govern','memory.canonicalize','memory.inspect'])
  AND EXISTS(SELECT 1 FROM public.registry_contracts c
    JOIN public.registry_releases r ON r.id=c.registry_release_id
    WHERE c.registry_release_id=release_id AND c.contract_id=contract
      AND c.contract_kind=kind AND r.lifecycle='RELEASED')
$$;
REVOKE ALL ON FUNCTION unai_private.registry_contract_present(uuid,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION unai_private.registry_contract_present(uuid,text,text) TO unai_app;

-- The belief transaction that is committing in this very database transaction, or
-- NULL. Plain STABLE: it only reads a transaction-local setting, and every caller
-- still has to find a matching COMMITTING row under its own row-level security.
CREATE FUNCTION unai_private.governing_belief_transaction() RETURNS uuid
LANGUAGE sql STABLE SET search_path=pg_catalog
AS $$ SELECT nullif(current_setting('unai.belief_transaction_id',true),'')::uuid $$;
REVOKE ALL ON FUNCTION unai_private.governing_belief_transaction() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION unai_private.governing_belief_transaction() TO unai_app;

-- The governor passes the evidence gate rather than around it, exactly as ADR 0016
-- §7 decided for extraction. Independence is a property of the source a claim came
-- from (PRD §15.4), so computing an independence group means reading the source
-- item behind the claim's anchor. `memory.govern` therefore joins the request
-- purposes `evidence_access` admits and nothing else about it changes: the
-- declared data purpose must still be one of the item's allowed purposes and the
-- declared maximum sensitivity must still be at or above the item's own, so a
-- transaction that declares neither still reads nothing and groups nothing.
CREATE OR REPLACE FUNCTION unai_private.evidence_access(purposes text[], sensitivity text) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT current_setting('unai.purpose',true) IN ('evidence.ingest','evidence.read','connector.read','memory.extract','memory.canonicalize','memory.govern')
 AND current_setting('unai.data_purpose',true)=ANY(purposes)
 AND array_position(ARRAY['NORMAL','PRIVATE','RESTRICTED'],sensitivity)
 <= array_position(ARRAY['NORMAL','PRIVATE','RESTRICTED'],current_setting('unai.maximum_sensitivity',true))
$$;

ALTER TABLE belief_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE belief_transactions FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_read ON belief_transactions FOR SELECT TO unai_app
 USING(unai_private.has_owner_access(owner_scope_id) AND unai_private.memory_purpose(ARRAY['memory.govern','memory.inspect']));
-- The requester is the authenticated actor of the session, bound here the same
-- way `devices.user_id` and `source_items.submitted_by_user_id` are: a proposal
-- cannot be attributed to somebody else.
CREATE POLICY owner_propose ON belief_transactions FOR INSERT TO unai_app
 WITH CHECK(unai_private.has_owner_access(owner_scope_id) AND unai_private.memory_purpose(ARRAY['memory.govern'])
 AND requested_by_actor_id=unai_private.actor_id());
CREATE POLICY owner_settle ON belief_transactions FOR UPDATE TO unai_app
 USING(unai_private.has_owner_access(owner_scope_id) AND unai_private.memory_purpose(ARRAY['memory.govern']))
 WITH CHECK(unai_private.has_owner_access(owner_scope_id) AND unai_private.memory_purpose(ARRAY['memory.govern']));
GRANT SELECT,INSERT ON belief_transactions TO unai_app;
GRANT UPDATE(status,admission_mode,policy_decision,policy_decision_id,validation,commit_receipt,rejection_reason,committed_at,rejected_at)
 ON belief_transactions TO unai_app;

ALTER TABLE belief_transaction_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE belief_transaction_operations FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_read ON belief_transaction_operations FOR SELECT TO unai_app
 USING(unai_private.has_owner_access(owner_scope_id) AND unai_private.memory_purpose(ARRAY['memory.govern','memory.inspect'])
 AND EXISTS(SELECT 1 FROM belief_transactions t WHERE t.owner_scope_id=belief_transaction_operations.owner_scope_id AND t.id=belief_transaction_id));
CREATE POLICY owner_propose ON belief_transaction_operations FOR INSERT TO unai_app
 WITH CHECK(unai_private.has_owner_access(owner_scope_id) AND unai_private.memory_purpose(ARRAY['memory.govern'])
 AND EXISTS(SELECT 1 FROM belief_transactions t WHERE t.owner_scope_id=belief_transaction_operations.owner_scope_id AND t.id=belief_transaction_id));
CREATE POLICY owner_record_result ON belief_transaction_operations FOR UPDATE TO unai_app
 USING(unai_private.has_owner_access(owner_scope_id) AND unai_private.memory_purpose(ARRAY['memory.govern']))
 WITH CHECK(unai_private.has_owner_access(owner_scope_id) AND unai_private.memory_purpose(ARRAY['memory.govern']));
GRANT SELECT,INSERT ON belief_transaction_operations TO unai_app;
GRANT UPDATE(result_object_refs) ON belief_transaction_operations TO unai_app;

ALTER TABLE belief_assessments ENABLE ROW LEVEL SECURITY;
ALTER TABLE belief_assessments FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_read ON belief_assessments FOR SELECT TO unai_app
 USING(unai_private.has_owner_access(owner_scope_id) AND unai_private.memory_purpose(ARRAY['memory.govern','memory.canonicalize','memory.inspect']));
CREATE POLICY owner_append ON belief_assessments FOR INSERT TO unai_app
 WITH CHECK(unai_private.has_owner_access(owner_scope_id) AND unai_private.memory_purpose(ARRAY['memory.govern']));
-- The one permitted update: closing a superseded version's recorded-time window.
CREATE POLICY owner_close ON belief_assessments FOR UPDATE TO unai_app
 USING(unai_private.has_owner_access(owner_scope_id) AND unai_private.memory_purpose(ARRAY['memory.govern']))
 WITH CHECK(unai_private.has_owner_access(owner_scope_id) AND unai_private.memory_purpose(ARRAY['memory.govern']));
GRANT SELECT,INSERT ON belief_assessments TO unai_app;
GRANT UPDATE(superseded_recorded_at) ON belief_assessments TO unai_app;

ALTER TABLE belief_support ENABLE ROW LEVEL SECURITY;
ALTER TABLE belief_support FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_read ON belief_support FOR SELECT TO unai_app
 USING(unai_private.has_owner_access(owner_scope_id) AND unai_private.memory_purpose(ARRAY['memory.govern','memory.canonicalize','memory.inspect']));
CREATE POLICY owner_append ON belief_support FOR INSERT TO unai_app
 WITH CHECK(unai_private.has_owner_access(owner_scope_id) AND unai_private.memory_purpose(ARRAY['memory.govern']));
GRANT SELECT,INSERT ON belief_support TO unai_app;

ALTER TABLE derived_proposition_dependencies ENABLE ROW LEVEL SECURITY;
ALTER TABLE derived_proposition_dependencies FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_read ON derived_proposition_dependencies FOR SELECT TO unai_app
 USING(unai_private.has_owner_access(owner_scope_id) AND unai_private.memory_purpose(ARRAY['memory.govern','memory.canonicalize','memory.inspect']));
CREATE POLICY owner_append ON derived_proposition_dependencies FOR INSERT TO unai_app
 WITH CHECK(unai_private.has_owner_access(owner_scope_id) AND unai_private.memory_purpose(ARRAY['memory.govern']));
GRANT SELECT,INSERT ON derived_proposition_dependencies TO unai_app;

ALTER TABLE policy_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE policy_decisions FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_read ON policy_decisions FOR SELECT TO unai_app
 USING(unai_private.has_owner_access(owner_scope_id)
 AND unai_private.memory_purpose(ARRAY['memory.govern','memory.read','memory.act','memory.inspect']));
CREATE POLICY owner_append ON policy_decisions FOR INSERT TO unai_app
 WITH CHECK(unai_private.has_owner_access(owner_scope_id)
 AND unai_private.memory_purpose(ARRAY['memory.govern','memory.read','memory.act']));
GRANT SELECT,INSERT ON policy_decisions TO unai_app;

-- A transaction is a record of what was decided, so only its settlement columns
-- move, and a settled transaction never reopens.
CREATE FUNCTION unai_private.belief_transaction_settle_only() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF NEW.id<>OLD.id OR NEW.owner_scope_id<>OLD.owner_scope_id OR NEW.transaction_kind<>OLD.transaction_kind
  OR NEW.requested_by_actor_id<>OLD.requested_by_actor_id OR NEW.source_evidence_ids<>OLD.source_evidence_ids
  OR NEW.registry_release_id<>OLD.registry_release_id OR NEW.risk<>OLD.risk
  OR NEW.idempotency_key<>OLD.idempotency_key OR NEW.proposed_at<>OLD.proposed_at THEN
  RAISE EXCEPTION 'BELIEF_TRANSACTION_IDENTITY_IMMUTABLE' USING ERRCODE='55000';
 END IF;
 IF OLD.status IN ('COMMITTED','REJECTED') AND NEW.status IS DISTINCT FROM OLD.status THEN
  RAISE EXCEPTION 'BELIEF_TRANSACTION_ALREADY_SETTLED' USING ERRCODE='55000';
 END IF;
 -- The receipt a commit answered with is the receipt every later commit answers
 -- with; rewriting it would make "identical receipts" a matter of timing.
 IF OLD.commit_receipt IS NOT NULL AND NEW.commit_receipt IS DISTINCT FROM OLD.commit_receipt THEN
  RAISE EXCEPTION 'BELIEF_TRANSACTION_RECEIPT_IMMUTABLE' USING ERRCODE='55000';
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION unai_private.belief_transaction_settle_only() FROM PUBLIC;
CREATE TRIGGER belief_transaction_settle_only BEFORE UPDATE ON belief_transactions
 FOR EACH ROW EXECUTE FUNCTION unai_private.belief_transaction_settle_only();

-- An operation's kind, order and payload are what was proposed; only the refs the
-- commit produced are written afterwards, and only once.
CREATE FUNCTION unai_private.belief_operation_result_only() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF NEW.id<>OLD.id OR NEW.owner_scope_id<>OLD.owner_scope_id OR NEW.belief_transaction_id<>OLD.belief_transaction_id
  OR NEW.operation_order<>OLD.operation_order OR NEW.operation_kind<>OLD.operation_kind OR NEW.payload<>OLD.payload THEN
  RAISE EXCEPTION 'BELIEF_OPERATION_IMMUTABLE' USING ERRCODE='55000';
 END IF;
 IF OLD.result_object_refs IS NOT NULL AND NEW.result_object_refs IS DISTINCT FROM OLD.result_object_refs THEN
  RAISE EXCEPTION 'BELIEF_OPERATION_RESULT_IMMUTABLE' USING ERRCODE='55000';
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION unai_private.belief_operation_result_only() FROM PUBLIC;
CREATE TRIGGER belief_operation_result_only BEFORE UPDATE ON belief_transaction_operations
 FOR EACH ROW EXECUTE FUNCTION unai_private.belief_operation_result_only();

-- What the kernel believed at a recorded time is never rewritten: a changed
-- verdict is a new row. Only the closing timestamp moves, and only once.
CREATE FUNCTION unai_private.belief_assessment_close_only() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF NEW.id<>OLD.id OR NEW.owner_scope_id<>OLD.owner_scope_id OR NEW.proposition_id<>OLD.proposition_id
  OR NEW.assessment_status<>OLD.assessment_status OR NEW.recorded_at<>OLD.recorded_at
  OR NEW.policy_version<>OLD.policy_version OR NEW.decision_reason<>OLD.decision_reason
  OR NEW.transaction_id<>OLD.transaction_id
  OR NEW.valid_from IS DISTINCT FROM OLD.valid_from OR NEW.valid_to IS DISTINCT FROM OLD.valid_to THEN
  RAISE EXCEPTION 'BELIEF_ASSESSMENT_APPEND_ONLY' USING ERRCODE='55000';
 END IF;
 IF OLD.superseded_recorded_at IS NOT NULL THEN
  RAISE EXCEPTION 'BELIEF_ASSESSMENT_ALREADY_SUPERSEDED' USING ERRCODE='55000';
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION unai_private.belief_assessment_close_only() FROM PUBLIC;
CREATE TRIGGER belief_assessment_close_only BEFORE UPDATE ON belief_assessments
 FOR EACH ROW EXECUTE FUNCTION unai_private.belief_assessment_close_only();

-- Support and derivation records are statements about a moment. Neither takes an
-- update grant, and neither may be rewritten by the privileged principal either.
CREATE FUNCTION unai_private.belief_record_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 RAISE EXCEPTION 'BELIEF_RECORD_IMMUTABLE' USING ERRCODE='55000';
END $$;
REVOKE ALL ON FUNCTION unai_private.belief_record_immutable() FROM PUBLIC;
CREATE TRIGGER belief_support_immutable BEFORE UPDATE ON belief_support
 FOR EACH ROW EXECUTE FUNCTION unai_private.belief_record_immutable();
CREATE TRIGGER derived_proposition_dependencies_immutable BEFORE UPDATE ON derived_proposition_dependencies
 FOR EACH ROW EXECUTE FUNCTION unai_private.belief_record_immutable();
CREATE TRIGGER policy_decisions_immutable BEFORE UPDATE ON policy_decisions
 FOR EACH ROW EXECUTE FUNCTION unai_private.belief_record_immutable();

-- Handoff from the canonical identity node (ADR 0015): `entity_lineage.transaction_id`
-- and `frame_instances.created_by_transaction_id` were `CHECK(... IS NULL)` because
-- `belief_transactions` did not exist. The table exists now, so the placeholders give
-- way to the composite owner foreign keys. No existing row is altered: the columns
-- are null on every row and stay null there. `context_spaces.creation_transaction_id`
-- gets the same treatment, so no column in the schema names a transaction that
-- nothing can resolve.
ALTER TABLE entity_lineage DROP CONSTRAINT entity_lineage_transaction_id_check;
ALTER TABLE entity_lineage ADD CONSTRAINT entity_lineage_transaction
 FOREIGN KEY(owner_scope_id,transaction_id) REFERENCES belief_transactions(owner_scope_id,id);
ALTER TABLE frame_instances DROP CONSTRAINT frame_instances_created_by_transaction_id_check;
ALTER TABLE frame_instances ADD CONSTRAINT frame_instances_created_by_transaction
 FOREIGN KEY(owner_scope_id,created_by_transaction_id) REFERENCES belief_transactions(owner_scope_id,id);
ALTER TABLE context_spaces ADD CONSTRAINT context_spaces_creation_transaction
 FOREIGN KEY(owner_scope_id,creation_transaction_id) REFERENCES belief_transactions(owner_scope_id,id);

-- Canonical identity is written by the governed transaction, so `memory.govern`
-- joins `memory.canonicalize` on the read and append policies migration 0010
-- installed. Nothing else about them changes: the owner check, the child EXISTS
-- clauses and the absent DELETE privilege are all reproduced exactly, and a
-- session holding an unrelated product purpose still reads none of it. A purpose
-- list inside an applied file can only be changed by replacing the policy, which
-- is what these drops and creates do.
DROP POLICY owner_read ON frame_instances;
CREATE POLICY owner_read ON frame_instances FOR SELECT TO unai_app
 USING(unai_private.has_owner_access(owner_scope_id) AND unai_private.memory_purpose(ARRAY['memory.canonicalize','memory.govern','memory.inspect']));
DROP POLICY owner_append ON frame_instances;
CREATE POLICY owner_append ON frame_instances FOR INSERT TO unai_app
 WITH CHECK(unai_private.has_owner_access(owner_scope_id) AND unai_private.memory_purpose(ARRAY['memory.canonicalize','memory.govern']));

DROP POLICY owner_read ON frame_instance_roles;
CREATE POLICY owner_read ON frame_instance_roles FOR SELECT TO unai_app
 USING(unai_private.has_owner_access(owner_scope_id) AND unai_private.memory_purpose(ARRAY['memory.canonicalize','memory.govern','memory.inspect'])
 AND EXISTS(SELECT 1 FROM frame_instances f WHERE f.owner_scope_id=frame_instance_roles.owner_scope_id AND f.id=frame_instance_id));
DROP POLICY owner_append ON frame_instance_roles;
CREATE POLICY owner_append ON frame_instance_roles FOR INSERT TO unai_app
 WITH CHECK(unai_private.has_owner_access(owner_scope_id) AND unai_private.memory_purpose(ARRAY['memory.canonicalize','memory.govern'])
 AND EXISTS(SELECT 1 FROM frame_instances f WHERE f.owner_scope_id=frame_instance_roles.owner_scope_id AND f.id=frame_instance_id));

DROP POLICY owner_read ON belief_slots;
CREATE POLICY owner_read ON belief_slots FOR SELECT TO unai_app
 USING(unai_private.has_owner_access(owner_scope_id) AND unai_private.memory_purpose(ARRAY['memory.canonicalize','memory.govern','memory.inspect']));
DROP POLICY owner_append ON belief_slots;
CREATE POLICY owner_append ON belief_slots FOR INSERT TO unai_app
 WITH CHECK(unai_private.has_owner_access(owner_scope_id) AND unai_private.memory_purpose(ARRAY['memory.canonicalize','memory.govern']));

DROP POLICY owner_read ON propositions;
CREATE POLICY owner_read ON propositions FOR SELECT TO unai_app
 USING(unai_private.has_owner_access(owner_scope_id) AND unai_private.memory_purpose(ARRAY['memory.canonicalize','memory.govern','memory.inspect']));
DROP POLICY owner_append ON propositions;
CREATE POLICY owner_append ON propositions FOR INSERT TO unai_app
 WITH CHECK(unai_private.has_owner_access(owner_scope_id) AND unai_private.memory_purpose(ARRAY['memory.canonicalize','memory.govern']));

DROP POLICY owner_read ON claims;
CREATE POLICY owner_read ON claims FOR SELECT TO unai_app
 USING(unai_private.has_owner_access(owner_scope_id) AND unai_private.memory_purpose(ARRAY['memory.canonicalize','memory.govern','memory.inspect']));
DROP POLICY owner_append ON claims;
CREATE POLICY owner_append ON claims FOR INSERT TO unai_app
 WITH CHECK(unai_private.has_owner_access(owner_scope_id) AND unai_private.memory_purpose(ARRAY['memory.canonicalize','memory.govern']));

-- The lookup indexes follow the rows they index: a slot the governor creates is
-- findable by the same fingerprint lookup as one canonicalization created, so
-- nothing the governed path writes is invisible to the resolver.
DROP POLICY owner_read ON slot_fingerprints;
CREATE POLICY owner_read ON slot_fingerprints FOR SELECT TO unai_app
 USING(unai_private.has_owner_access(owner_scope_id) AND unai_private.memory_purpose(ARRAY['memory.canonicalize','memory.govern','memory.inspect']));
DROP POLICY owner_append ON slot_fingerprints;
CREATE POLICY owner_append ON slot_fingerprints FOR INSERT TO unai_app
 WITH CHECK(unai_private.has_owner_access(owner_scope_id) AND unai_private.memory_purpose(ARRAY['memory.canonicalize','memory.govern']));

DROP POLICY owner_read ON proposition_fingerprints;
CREATE POLICY owner_read ON proposition_fingerprints FOR SELECT TO unai_app
 USING(unai_private.has_owner_access(owner_scope_id) AND unai_private.memory_purpose(ARRAY['memory.canonicalize','memory.govern','memory.inspect']));
DROP POLICY owner_append ON proposition_fingerprints;
CREATE POLICY owner_append ON proposition_fingerprints FOR INSERT TO unai_app
 WITH CHECK(unai_private.has_owner_access(owner_scope_id) AND unai_private.memory_purpose(ARRAY['memory.canonicalize','memory.govern']));

DROP POLICY owner_read ON entities;
CREATE POLICY owner_read ON entities FOR SELECT TO unai_app
 USING(unai_private.has_owner_access(owner_scope_id) AND unai_private.memory_purpose(ARRAY['memory.canonicalize','memory.govern','memory.inspect']));

-- A claim moves through its lifecycle only under a governed transaction: this is
-- the update policy migration 0010 deliberately left to this node. Everything that
-- makes the claim the assertion it is stays immutable, so invalidating an input
-- (CRT-AI-02-A) changes the verdict on it and never what it said.
CREATE POLICY governed_lifecycle ON claims FOR UPDATE TO unai_app
 USING(unai_private.has_owner_access(owner_scope_id) AND unai_private.memory_purpose(ARRAY['memory.govern']))
 WITH CHECK(unai_private.has_owner_access(owner_scope_id) AND unai_private.memory_purpose(ARRAY['memory.govern']));
GRANT UPDATE(lifecycle,proposition_id) ON claims TO unai_app;

CREATE FUNCTION unai_private.claim_lifecycle_only() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF NEW.id<>OLD.id OR NEW.owner_scope_id<>OLD.owner_scope_id OR NEW.source_anchor_id<>OLD.source_anchor_id
  OR NEW.claim_origin<>OLD.claim_origin OR NEW.recorded_at<>OLD.recorded_at
  OR NEW.extraction_run_id IS DISTINCT FROM OLD.extraction_run_id
  OR NEW.asserted_by_entity_id IS DISTINCT FROM OLD.asserted_by_entity_id
  OR NEW.temporal_interpretation IS DISTINCT FROM OLD.temporal_interpretation
  OR NEW.metadata IS DISTINCT FROM OLD.metadata THEN
  RAISE EXCEPTION 'CLAIM_ASSERTION_IMMUTABLE' USING ERRCODE='55000';
 END IF;
 -- A claim is attached to its proposition once; re-pointing it would move an
 -- assertion from one belief to another without any evidence saying so.
 IF OLD.proposition_id IS NOT NULL AND NEW.proposition_id IS DISTINCT FROM OLD.proposition_id THEN
  RAISE EXCEPTION 'CLAIM_ATTACHMENT_IMMUTABLE' USING ERRCODE='55000';
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION unai_private.claim_lifecycle_only() FROM PUBLIC;
CREATE TRIGGER claim_lifecycle_only BEFORE UPDATE ON claims
 FOR EACH ROW EXECUTE FUNCTION unai_private.claim_lifecycle_only();

-- A proposition may be retired or merged away under a governed transaction; its
-- slot, value and polarity never move, because that would silently restate what
-- an earlier claim asserted.
CREATE POLICY governed_lifecycle ON propositions FOR UPDATE TO unai_app
 USING(unai_private.has_owner_access(owner_scope_id) AND unai_private.memory_purpose(ARRAY['memory.govern']))
 WITH CHECK(unai_private.has_owner_access(owner_scope_id) AND unai_private.memory_purpose(ARRAY['memory.govern']));
GRANT UPDATE(lifecycle,retired_at) ON propositions TO unai_app;

CREATE FUNCTION unai_private.proposition_lifecycle_only() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF NEW.id<>OLD.id OR NEW.owner_scope_id<>OLD.owner_scope_id OR NEW.belief_slot_id<>OLD.belief_slot_id
  OR NEW.normalized_value<>OLD.normalized_value OR NEW.polarity<>OLD.polarity OR NEW.created_at<>OLD.created_at THEN
  RAISE EXCEPTION 'PROPOSITION_VALUE_IMMUTABLE' USING ERRCODE='55000';
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION unai_private.proposition_lifecycle_only() FROM PUBLIC;
CREATE TRIGGER proposition_lifecycle_only BEFORE UPDATE ON propositions
 FOR EACH ROW EXECUTE FUNCTION unai_private.proposition_lifecycle_only();

-- CRT-REG-06-B. A proposition's context is its slot's context space, so moving a
-- proposition from QUOTED to BASE is an update of `belief_slots.context_space_id`.
-- It is permitted only while a belief transaction of this owner scope is
-- committing in this very database transaction, named by `unai.belief_transaction_id`.
-- The trigger is not SECURITY DEFINER and the policies are `TO unai_app`, so a
-- direct update by any other principal finds no COMMITTING row and is refused too.
CREATE POLICY governed_requalify ON belief_slots FOR UPDATE TO unai_app
 USING(unai_private.has_owner_access(owner_scope_id) AND unai_private.memory_purpose(ARRAY['memory.govern']))
 WITH CHECK(unai_private.has_owner_access(owner_scope_id) AND unai_private.memory_purpose(ARRAY['memory.govern']));
GRANT UPDATE(context_space_id,qualifiers,lifecycle) ON belief_slots TO unai_app;

CREATE FUNCTION unai_private.belief_slot_governed_update() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF NEW.id<>OLD.id OR NEW.owner_scope_id<>OLD.owner_scope_id OR NEW.frame_instance_id<>OLD.frame_instance_id
  OR NEW.predicate_id<>OLD.predicate_id OR NEW.modality<>OLD.modality OR NEW.created_at<>OLD.created_at THEN
  RAISE EXCEPTION 'BELIEF_SLOT_IDENTITY_IMMUTABLE' USING ERRCODE='55000';
 END IF;
 IF NEW.context_space_id IS DISTINCT FROM OLD.context_space_id
  AND NOT EXISTS(SELECT 1 FROM public.belief_transactions t
    WHERE t.id=unai_private.governing_belief_transaction()
      AND t.owner_scope_id=NEW.owner_scope_id AND t.status='COMMITTING') THEN
  RAISE EXCEPTION 'CONTEXT_MOVE_REQUIRES_TRANSACTION' USING ERRCODE='55000';
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION unai_private.belief_slot_governed_update() FROM PUBLIC;
CREATE TRIGGER belief_slot_governed_update BEFORE UPDATE ON belief_slots
 FOR EACH ROW EXECUTE FUNCTION unai_private.belief_slot_governed_update();
