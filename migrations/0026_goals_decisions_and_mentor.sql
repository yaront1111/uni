-- Goals, decisions and the mentor (design entities `goals`,
-- `goal_priority_history` and `decision_projection`, plus `mentor_cards`;
-- PRD §7.4, §25.3, §36.13, §37.7, §52). ADR 0029 records the decisions below
-- before the code.
--
-- Four rules are carried by the schema rather than by convention:
--
--  1. A priority change appends history and overwrites nothing (CRT-DEC-01-A).
--     `goal_priority_history` is append-only for every principal, the migration
--     owner included, and `goals.current_priority` may only move to a priority
--     the same transaction appended to that history. A goal cannot exist without
--     its INITIAL history row: a deferred trigger checks it at commit.
--  2. `decision_projection` is a typed projection like those of migration 0016:
--     typed columns for every field the Decisions workspace shows, the nine PRD
--     §33.12 metadata columns NOT NULL, the source decision frame as identity,
--     written only under `memory.project`, rebuildable and therefore deletable.
--  3. A mentor card is a statement about one moment and is never restated. It
--     keeps its evidence, its inference and its recommendation as three separate
--     values, the packet it was composed from, and the interruption decision that
--     emitted or withheld it with the inputs that decision logged.
--  4. The attention budget is one budget. The mentor reads the owner's budget and
--     the day's asked clarification cards, and the inbox reads the day's emitted
--     mentor cards, so the two proactive surfaces are counted together.

CREATE TABLE goals (
 id uuid PRIMARY KEY,
 owner_scope_id uuid NOT NULL REFERENCES owner_scopes(id),
 title text NOT NULL CHECK(length(title) BETWEEN 1 AND 200),
 -- The life categories the Context Broker derives, so a goal and the calendar are
 -- compared in one vocabulary.
 domain text NOT NULL CHECK(domain IN ('FINANCE','FAMILY','WORK','HEALTH','ADMIN','PERSONAL')),
 current_priority text NOT NULL CHECK(current_priority IN ('HIGH','MEDIUM','LOW','PAUSED')),
 -- The active temporary override, a cache of its TEMPORARY_OVERRIDE history row.
 temporary_override jsonb CHECK(temporary_override IS NULL OR (jsonb_typeof(temporary_override)='object'
  AND temporary_override ?& ARRAY['historyId','priority','validFrom','validTo','reason'])),
 created_by_user_id uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 retired_at timestamptz,
 UNIQUE(owner_scope_id,id),
 FOREIGN KEY(owner_scope_id,created_by_user_id) REFERENCES owner_scope_members(owner_scope_id,user_id)
);
CREATE INDEX goals_owner ON goals(owner_scope_id,created_at,id);

CREATE TABLE goal_priority_history (
 id uuid PRIMARY KEY,
 owner_scope_id uuid NOT NULL REFERENCES owner_scopes(id),
 goal_id uuid NOT NULL,
 change_kind text NOT NULL CHECK(change_kind IN ('INITIAL','CHANGE','TEMPORARY_OVERRIDE')),
 priority text NOT NULL CHECK(priority IN ('HIGH','MEDIUM','LOW','PAUSED')),
 valid_from timestamptz NOT NULL,
 valid_to timestamptz,
 -- Stamped by the database, never by the caller: the transaction's own time is
 -- what ties a goal's cached priority to the history row it came from.
 recorded_at timestamptz NOT NULL DEFAULT now(),
 reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 500),
 recorded_by_user_id uuid NOT NULL,
 UNIQUE(owner_scope_id,id),
 FOREIGN KEY(owner_scope_id,goal_id) REFERENCES goals(owner_scope_id,id),
 FOREIGN KEY(owner_scope_id,recorded_by_user_id) REFERENCES owner_scope_members(owner_scope_id,user_id),
 CONSTRAINT goal_priority_history_interval CHECK(valid_to IS NULL OR valid_to > valid_from),
 CONSTRAINT goal_priority_history_override_bounded CHECK(change_kind<>'TEMPORARY_OVERRIDE' OR valid_to IS NOT NULL)
);
CREATE INDEX goal_priority_history_goal ON goal_priority_history(owner_scope_id,goal_id,recorded_at,id);

CREATE FUNCTION unai_private.goal_priority_history_stamp() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 NEW.recorded_at := now();
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION unai_private.goal_priority_history_stamp() FROM PUBLIC;
CREATE TRIGGER goal_priority_history_stamp BEFORE INSERT ON goal_priority_history
 FOR EACH ROW EXECUTE FUNCTION unai_private.goal_priority_history_stamp();

CREATE FUNCTION unai_private.goal_priority_history_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 RAISE EXCEPTION 'GOAL_PRIORITY_HISTORY_IMMUTABLE' USING ERRCODE='55000';
END $$;
REVOKE ALL ON FUNCTION unai_private.goal_priority_history_immutable() FROM PUBLIC;
CREATE TRIGGER goal_priority_history_immutable BEFORE UPDATE OR DELETE ON goal_priority_history
 FOR EACH ROW EXECUTE FUNCTION unai_private.goal_priority_history_immutable();

-- A goal's identity never changes, a retired goal stays retired, and its cached
-- priority and override only ever follow a history row this transaction wrote.
CREATE FUNCTION unai_private.goal_update_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF NEW.id<>OLD.id OR NEW.owner_scope_id<>OLD.owner_scope_id OR NEW.title<>OLD.title OR NEW.domain<>OLD.domain
  OR NEW.created_by_user_id<>OLD.created_by_user_id OR NEW.created_at<>OLD.created_at THEN
  RAISE EXCEPTION 'GOAL_IDENTITY_IMMUTABLE' USING ERRCODE='55000';
 END IF;
 IF OLD.retired_at IS NOT NULL AND NEW.retired_at IS DISTINCT FROM OLD.retired_at THEN
  RAISE EXCEPTION 'GOAL_RETIRED' USING ERRCODE='55000';
 END IF;
 IF NEW.current_priority<>OLD.current_priority AND NOT EXISTS(SELECT 1 FROM public.goal_priority_history h
   WHERE h.owner_scope_id=NEW.owner_scope_id AND h.goal_id=NEW.id AND h.change_kind='CHANGE'
     AND h.priority=NEW.current_priority AND h.recorded_at=now()) THEN
  RAISE EXCEPTION 'GOAL_PRIORITY_REQUIRES_HISTORY' USING ERRCODE='55000';
 END IF;
 IF NEW.temporary_override IS NOT NULL AND NEW.temporary_override IS DISTINCT FROM OLD.temporary_override
  AND NOT EXISTS(SELECT 1 FROM public.goal_priority_history h
   WHERE h.owner_scope_id=NEW.owner_scope_id AND h.goal_id=NEW.id AND h.change_kind='TEMPORARY_OVERRIDE'
     AND h.id::text=NEW.temporary_override->>'historyId' AND h.priority=NEW.temporary_override->>'priority'
     AND h.recorded_at=now()) THEN
  RAISE EXCEPTION 'GOAL_OVERRIDE_REQUIRES_HISTORY' USING ERRCODE='55000';
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION unai_private.goal_update_guard() FROM PUBLIC;
CREATE TRIGGER goals_update_guard BEFORE UPDATE ON goals
 FOR EACH ROW EXECUTE FUNCTION unai_private.goal_update_guard();

-- Checked at commit, so the goal and its first history row can be written in
-- either order inside the one transaction that creates them.
CREATE FUNCTION unai_private.goal_has_history() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.goal_priority_history h
   WHERE h.owner_scope_id=NEW.owner_scope_id AND h.goal_id=NEW.id AND h.change_kind='INITIAL'
     AND h.priority=NEW.current_priority) THEN
  RAISE EXCEPTION 'GOAL_INITIAL_HISTORY_REQUIRED' USING ERRCODE='55000';
 END IF;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION unai_private.goal_has_history() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER goals_initial_history AFTER INSERT ON goals
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION unai_private.goal_has_history();

-- The Decisions workspace's projection (design entity `decision_projection`;
-- PRD §25.3). A cache of canonical `shared.decision` memory like the three
-- projections of migration 0016, and deletable for the same reason.
CREATE TABLE decision_projection (
 owner_scope_id uuid NOT NULL REFERENCES owner_scopes(id),
 decision_frame_instance_id uuid NOT NULL,
 question text CHECK(question IS NULL OR length(question) BETWEEN 1 AND 4096),
 alternatives jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(alternatives)='array'),
 assumptions jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(assumptions)='array'),
 cross_domain_consequences jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(cross_domain_consequences)='array'),
 recommendation text CHECK(recommendation IS NULL OR length(recommendation) BETWEEN 1 AND 4096),
 user_choice text CHECK(user_choice IS NULL OR length(user_choice) BETWEEN 1 AND 4096),
 rationale text CHECK(rationale IS NULL OR length(rationale) BETWEEN 1 AND 4096),
 expected_result text CHECK(expected_result IS NULL OR length(expected_result) BETWEEN 1 AND 4096),
 review_date timestamptz,
 -- Set by the clock and by nothing else: a passed review date creates no review.
 review_due boolean NOT NULL DEFAULT false,
 actual_outcome text CHECK(actual_outcome IS NULL OR length(actual_outcome) BETWEEN 1 AND 4096),
 review_outcome_code text CHECK(review_outcome_code IS NULL OR review_outcome_code IN ('CONFIRMED','REFUTED','PARTIALLY_CONFIRMED')),
 -- A review is proposed until a governed transaction accepts it; the row says which.
 review_lifecycle text CHECK(review_lifecycle IS NULL OR review_lifecycle IN ('PROPOSED','ACCEPTED','CONTESTED')),
 outcome_state text NOT NULL CHECK(outcome_state IN ('UNRESOLVED','PARTIALLY_RESOLVED','RESOLVED','CONTESTED')),
 related_goal_id uuid,
 predicted_outcome_proposition_ids uuid[] NOT NULL DEFAULT '{}',
 actual_resolution_ids uuid[] NOT NULL DEFAULT '{}',
 conflict_flag boolean NOT NULL DEFAULT false,
 projection_version uuid NOT NULL,
 canonical_transaction_watermark timestamptz NOT NULL,
 owner_overlay_watermark bigint NOT NULL CHECK(owner_overlay_watermark >= 0),
 reducer_version text NOT NULL CHECK(reducer_version ~ '^[a-z][a-z0-9_.-]{0,63}$'),
 is_complete boolean NOT NULL,
 source_manifest jsonb NOT NULL CHECK(jsonb_typeof(source_manifest)='object'),
 updated_at timestamptz NOT NULL,
 PRIMARY KEY(owner_scope_id,decision_frame_instance_id),
 FOREIGN KEY(owner_scope_id,decision_frame_instance_id) REFERENCES frame_instances(owner_scope_id,id),
 FOREIGN KEY(owner_scope_id,related_goal_id) REFERENCES goals(owner_scope_id,id),
 CONSTRAINT decision_projection_review_paired CHECK((review_outcome_code IS NULL)=(review_lifecycle IS NULL))
);
CREATE INDEX decision_projection_review ON decision_projection(owner_scope_id,review_date,outcome_state);
CREATE INDEX decision_projection_goal ON decision_projection(owner_scope_id,related_goal_id);
CREATE INDEX decision_projection_incomplete ON decision_projection(owner_scope_id,updated_at) WHERE is_complete=false;

CREATE FUNCTION unai_private.decision_projection_identity() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF NEW.owner_scope_id<>OLD.owner_scope_id
  OR NEW.decision_frame_instance_id<>OLD.decision_frame_instance_id THEN
  RAISE EXCEPTION 'PROJECTION_IDENTITY_IMMUTABLE' USING ERRCODE='55000';
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION unai_private.decision_projection_identity() FROM PUBLIC;
CREATE TRIGGER decision_projection_identity BEFORE UPDATE ON decision_projection
 FOR EACH ROW EXECUTE FUNCTION unai_private.decision_projection_identity();

-- A decision replay is recorded like any other projection rebuild.
ALTER TABLE projection_rebuild_receipts DROP CONSTRAINT projection_rebuild_receipts_projection_name_check;
ALTER TABLE projection_rebuild_receipts ADD CONSTRAINT projection_rebuild_receipts_projection_name_check
 CHECK(projection_name IN ('open_commitments_projection','obligations_projection','schedule_projection','decision_projection'));

-- Every evaluation of a mentor card (ADR 0029 §7). Append-only.
CREATE TABLE mentor_cards (
 id uuid PRIMARY KEY,
 owner_scope_id uuid NOT NULL REFERENCES owner_scopes(id),
 card_kind text NOT NULL CHECK(card_kind IN ('GOAL_CALENDAR_CONTRADICTION')),
 goal_id uuid NOT NULL,
 -- The priority statement the card measured behaviour against.
 goal_priority_history_id uuid NOT NULL,
 evidence jsonb NOT NULL CHECK(jsonb_typeof(evidence)='array' AND jsonb_array_length(evidence) BETWEEN 1 AND 20),
 inference jsonb NOT NULL CHECK(jsonb_typeof(inference)='object' AND inference ?& ARRAY['text','confidence','counterexampleSearch']),
 recommendation jsonb NOT NULL CHECK(jsonb_typeof(recommendation)='object' AND recommendation ? 'text'),
 observation_window_start timestamptz NOT NULL,
 observation_window_end timestamptz NOT NULL,
 confidence numeric NOT NULL CHECK(confidence >= 0 AND confidence <= 1),
 evidence_ids uuid[] NOT NULL DEFAULT '{}',
 sensitivity_scope text NOT NULL CHECK(sensitivity_scope ~ '^(FINANCE|FAMILY|WORK|HEALTH|ADMIN|PERSONAL)/(NORMAL|PRIVATE|RESTRICTED)$'),
 decision text NOT NULL CHECK(decision IN ('ASK','BATCH','SUPPRESS')),
 reason text NOT NULL CHECK(reason ~ '^[A-Z][A-Z0-9_]{0,63}$'),
 policy_inputs jsonb NOT NULL CHECK(jsonb_typeof(policy_inputs)='object'
  AND policy_inputs ?& ARRAY['errorProbability','consequence','irreversibility','urgency','interruptionCost','budget']),
 owner_local_date date NOT NULL,
 policy_version text NOT NULL CHECK(policy_version ~ '^[a-z][a-z0-9_.-]{0,63}$'),
 composer_version text NOT NULL CHECK(composer_version ~ '^[a-z][a-z0-9_.-]{0,63}$'),
 context_packet_id uuid NOT NULL,
 packet_hash text NOT NULL CHECK(packet_hash ~ '^[a-f0-9]{64}$'),
 decided_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(owner_scope_id,id),
 FOREIGN KEY(owner_scope_id,goal_id) REFERENCES goals(owner_scope_id,id),
 FOREIGN KEY(owner_scope_id,goal_priority_history_id) REFERENCES goal_priority_history(owner_scope_id,id),
 FOREIGN KEY(owner_scope_id,context_packet_id) REFERENCES context_packets(owner_scope_id,id),
 CONSTRAINT mentor_cards_window CHECK(observation_window_end > observation_window_start)
);
CREATE INDEX mentor_cards_day ON mentor_cards(owner_scope_id,owner_local_date,decision,sensitivity_scope);
CREATE INDEX mentor_cards_goal ON mentor_cards(owner_scope_id,goal_id,decided_at DESC);

CREATE FUNCTION unai_private.mentor_card_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 RAISE EXCEPTION 'MENTOR_CARD_IMMUTABLE' USING ERRCODE='55000';
END $$;
REVOKE ALL ON FUNCTION unai_private.mentor_card_immutable() FROM PUBLIC;
CREATE TRIGGER mentor_cards_immutable BEFORE UPDATE OR DELETE ON mentor_cards
 FOR EACH ROW EXECUTE FUNCTION unai_private.mentor_card_immutable();

-- Purposes. `goals.read` and `goals.manage` are the Goals screen's; `mentor.advise`
-- reads goals and the budget and records mentor cards; `decisions.record` checks a
-- decision's goal reference. No purpose here appears in a policy on a canonical
-- table: a decision is canonicalized under `memory.canonicalize`, and memory is
-- read through the Context Broker under `memory.read`.
ALTER TABLE goals ENABLE ROW LEVEL SECURITY;
ALTER TABLE goals FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_read ON goals FOR SELECT TO unai_app
 USING(unai_private.has_owner_access(owner_scope_id)
 AND unai_private.memory_purpose(ARRAY['goals.read','goals.manage','mentor.advise','decisions.record','decisions.read']));
CREATE POLICY owner_state ON goals FOR INSERT TO unai_app
 WITH CHECK(unai_private.has_owner_access(owner_scope_id) AND unai_private.memory_purpose(ARRAY['goals.manage'])
 AND created_by_user_id=unai_private.actor_id());
CREATE POLICY owner_reprioritize ON goals FOR UPDATE TO unai_app
 USING(unai_private.has_owner_access(owner_scope_id) AND unai_private.memory_purpose(ARRAY['goals.manage']))
 WITH CHECK(unai_private.has_owner_access(owner_scope_id) AND unai_private.memory_purpose(ARRAY['goals.manage']));
GRANT SELECT,INSERT ON goals TO unai_app;
GRANT UPDATE(current_priority,temporary_override,retired_at) ON goals TO unai_app;

ALTER TABLE goal_priority_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE goal_priority_history FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_read ON goal_priority_history FOR SELECT TO unai_app
 USING(unai_private.has_owner_access(owner_scope_id)
 AND unai_private.memory_purpose(ARRAY['goals.read','goals.manage','mentor.advise']));
CREATE POLICY owner_append ON goal_priority_history FOR INSERT TO unai_app
 WITH CHECK(unai_private.has_owner_access(owner_scope_id) AND unai_private.memory_purpose(ARRAY['goals.manage'])
 AND recorded_by_user_id=unai_private.actor_id());
GRANT SELECT,INSERT ON goal_priority_history TO unai_app;

ALTER TABLE decision_projection ENABLE ROW LEVEL SECURITY;
ALTER TABLE decision_projection FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_read ON decision_projection FOR SELECT TO unai_app
 USING(unai_private.has_owner_access(owner_scope_id)
 AND unai_private.memory_purpose(ARRAY['memory.project','projection.read','memory.inspect','memory.govern','decisions.read','decisions.record']));
CREATE POLICY owner_reduce ON decision_projection FOR INSERT TO unai_app
 WITH CHECK(unai_private.has_owner_access(owner_scope_id) AND unai_private.memory_purpose(ARRAY['memory.project']));
CREATE POLICY owner_restate ON decision_projection FOR UPDATE TO unai_app
 USING(unai_private.has_owner_access(owner_scope_id) AND unai_private.memory_purpose(ARRAY['memory.project']))
 WITH CHECK(unai_private.has_owner_access(owner_scope_id) AND unai_private.memory_purpose(ARRAY['memory.project']));
CREATE POLICY owner_rebuild ON decision_projection FOR DELETE TO unai_app
 USING(unai_private.has_owner_access(owner_scope_id) AND unai_private.memory_purpose(ARRAY['memory.project']));
GRANT SELECT,INSERT,UPDATE,DELETE ON decision_projection TO unai_app;

ALTER TABLE mentor_cards ENABLE ROW LEVEL SECURITY;
ALTER TABLE mentor_cards FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_read ON mentor_cards FOR SELECT TO unai_app
 USING(unai_private.has_owner_access(owner_scope_id)
 AND unai_private.memory_purpose(ARRAY['mentor.advise','memory.inbox','goals.read']));
CREATE POLICY owner_record ON mentor_cards FOR INSERT TO unai_app
 WITH CHECK(unai_private.has_owner_access(owner_scope_id) AND unai_private.memory_purpose(ARRAY['mentor.advise']));
GRANT SELECT,INSERT ON mentor_cards TO unai_app;

-- The one attention budget (rule 4). Each policy is reproduced whole with its
-- existing predicate and one purpose more: the mentor reads the owner's budget
-- and counts the day's asked clarification cards, and changes neither.
DROP POLICY owner_read ON attention_budgets;
CREATE POLICY owner_read ON attention_budgets FOR SELECT TO unai_app
 USING(unai_private.has_owner_access(owner_scope_id) AND unai_private.memory_purpose(ARRAY['memory.inbox','settings.attention','mentor.advise']));
DROP POLICY owner_read ON clarification_cards;
CREATE POLICY owner_read ON clarification_cards FOR SELECT TO unai_app
 USING(unai_private.has_owner_access(owner_scope_id) AND unai_private.memory_purpose(ARRAY['memory.inbox','approval.rules','mentor.advise']));

-- The pinned release's transition contracts, read from the published snapshot
-- (ADR 0029 §6). Content of TRANSITION contracts only, of the newest released
-- release, and only for the decision review's own purpose. Releases are read
-- before contracts, the order the snapshot is written and guarded in (ADR 0028 §10).
CREATE FUNCTION unai_private.registry_transition_contracts() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 WITH loaded AS (
  SELECT r.id,r.semantic_version FROM public.registry_releases r
  WHERE unai_private.owner_id() IS NOT NULL
    AND current_setting('unai.purpose',true)='decisions.record'
    AND r.lifecycle='RELEASED'
  ORDER BY string_to_array(r.semantic_version,'.')::int[] DESC, r.released_at DESC
  LIMIT 1
 )
 SELECT jsonb_build_object('registryReleaseId',l.id,'semanticVersion',l.semantic_version,
  'contracts',coalesce((SELECT jsonb_agg(c.content ORDER BY c.contract_id)
    FROM public.registry_contracts c WHERE c.registry_release_id=l.id AND c.contract_kind='TRANSITION'),'[]'::jsonb))
 FROM loaded l
$$;
REVOKE ALL ON FUNCTION unai_private.registry_transition_contracts() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION unai_private.registry_transition_contracts() TO unai_app;
