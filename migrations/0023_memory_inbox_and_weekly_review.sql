-- Proactive clarification and the weekly review (design entities
-- `attention_budgets`, `learned_approval_rules`, `clarification_cards`,
-- `interruption_decisions`, `weekly_reviews`, `behavioral_observations`;
-- PRD §19.3, §19.4, §19.5, §37.4, §39). ADR 0029 records the decisions below
-- before the code.
--
-- Five rules are carried by the schema rather than by convention:
--
--  1. Each surface has its own purpose. `memory.inbox` reads and evaluates cards
--     and logs interruption decisions; `approval.rules` approves and revokes
--     learned rules; `settings.attention` changes the budget; `review.weekly`
--     records a review. None of them appears in a policy on a canonical table:
--     answering a card writes memory through the correction path under
--     `memory.correct`, and a review reads memory through the Context Broker
--     under `memory.read`.
--  2. An interruption decision, a weekly review and a behavioral observation
--     are statements about one moment: append-only and immutable.
--  3. A learned approval rule moves only PROPOSED -> APPROVED -> REVOKED (or
--     PROPOSED -> REVOKED), approval names the approving session's own actor,
--     and a revoked rule never returns (PRD §19.5).
--  4. A behavioral observation cannot be stored with fewer than two supporting
--     episodes, and always stores its counterexample search, window, confidence
--     and review date (PRD §39, CRT-UX-06-A).
--  5. A review and an observation reference the persisted packet they were
--     composed from, so every statement stays checkable against its manifest.

-- The owner's attention budget. One row per owner scope at most; the absence of a
-- row is the PRD §19.3 default, which the service reports as such.
CREATE TABLE attention_budgets (
 owner_scope_id uuid PRIMARY KEY REFERENCES owner_scopes(id),
 max_cards_per_day integer NOT NULL DEFAULT 3 CHECK(max_cards_per_day BETWEEN 0 AND 50),
 max_cards_per_sensitivity_scope_per_day integer NOT NULL DEFAULT 1
  CHECK(max_cards_per_sensitivity_scope_per_day BETWEEN 0 AND 50),
 repeat_question_suppression_days integer NOT NULL DEFAULT 7 CHECK(repeat_question_suppression_days BETWEEN 1 AND 365),
 updated_by_user_id uuid NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(owner_scope_id,updated_by_user_id) REFERENCES owner_scope_members(owner_scope_id,user_id)
);

-- A learned approval rule (PRD §19.5). `rule_signature` is a lookup index over
-- the scope a card is matched on, never an identity.
CREATE TABLE learned_approval_rules (
 id uuid PRIMARY KEY,
 owner_scope_id uuid NOT NULL REFERENCES owner_scopes(id),
 rule_text text NOT NULL CHECK(length(rule_text) BETWEEN 1 AND 500),
 scope jsonb NOT NULL CHECK(jsonb_typeof(scope)='object'),
 rule_signature text NOT NULL CHECK(rule_signature ~ '^[a-f0-9]{64}$'),
 status text NOT NULL DEFAULT 'PROPOSED' CHECK(status IN ('PROPOSED','APPROVED','REVOKED')),
 proposed_from_card_ids uuid[] NOT NULL CHECK(cardinality(proposed_from_card_ids) BETWEEN 2 AND 64),
 proposed_at timestamptz NOT NULL DEFAULT now(),
 approved_by_user_id uuid,
 approved_at timestamptz,
 revoked_at timestamptz,
 UNIQUE(owner_scope_id,id),
 FOREIGN KEY(owner_scope_id,approved_by_user_id) REFERENCES owner_scope_members(owner_scope_id,user_id),
 CONSTRAINT learned_approval_rules_proposed CHECK(status<>'PROPOSED' OR (approved_at IS NULL AND approved_by_user_id IS NULL AND revoked_at IS NULL)),
 CONSTRAINT learned_approval_rules_approved CHECK(status<>'APPROVED' OR (approved_at IS NOT NULL AND approved_by_user_id IS NOT NULL AND revoked_at IS NULL)),
 CONSTRAINT learned_approval_rules_revoked CHECK(status<>'REVOKED' OR revoked_at IS NOT NULL)
);
-- One live rule per signature: repeating the same confirmations proposes nothing
-- new while a proposal or an approval already stands.
CREATE UNIQUE INDEX learned_approval_rules_live ON learned_approval_rules(owner_scope_id,rule_signature) WHERE status<>'REVOKED';

-- One card per situation (PRD §37.4). A situation has at most one card that is
-- not RESOLVED; a resolved card stays as history.
CREATE TABLE clarification_cards (
 id uuid PRIMARY KEY,
 owner_scope_id uuid NOT NULL REFERENCES owner_scopes(id),
 situation_key text NOT NULL CHECK(situation_key ~ '^(thread|frame):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
 situation_kind text NOT NULL CHECK(situation_kind IN ('REPAYMENT','GENERAL')),
 title text NOT NULL CHECK(length(title) BETWEEN 1 AND 200),
 facts jsonb NOT NULL CHECK(jsonb_typeof(facts)='array'),
 why_it_matters text NOT NULL CHECK(length(why_it_matters) BETWEEN 1 AND 1000),
 -- Each choice states what it will change (design: "choices jsonb (each with
 -- what it will change)").
 choices jsonb NOT NULL CHECK(jsonb_typeof(choices)='array' AND jsonb_array_length(choices) BETWEEN 2 AND 8),
 grouped_ambiguity_ids uuid[] NOT NULL CHECK(cardinality(grouped_ambiguity_ids) BETWEEN 1 AND 64),
 ambiguities jsonb NOT NULL CHECK(jsonb_typeof(ambiguities)='array'),
 sensitivity_scope text NOT NULL
  CHECK(sensitivity_scope ~ '^(FINANCE|FAMILY|WORK|HEALTH|ADMIN|PERSONAL)/(NORMAL|PRIVATE|RESTRICTED)$'),
 rule_signature text CHECK(rule_signature IS NULL OR rule_signature ~ '^[a-f0-9]{64}$'),
 rule_scope jsonb CHECK(rule_scope IS NULL OR jsonb_typeof(rule_scope)='object'),
 -- The evidence behind the card when it was last asked: an id outside this set is
 -- material new evidence (ADR 0029 §4).
 known_evidence_ids uuid[] NOT NULL DEFAULT '{}',
 evidence_ids uuid[] NOT NULL DEFAULT '{}',
 policy_inputs jsonb NOT NULL CHECK(jsonb_typeof(policy_inputs)='object'),
 status text NOT NULL DEFAULT 'OPEN' CHECK(status IN ('OPEN','ASKED','DEFERRED','SUPPRESSED','RESOLVED','CLEARED')),
 asked_at timestamptz,
 asked_on date,
 last_evaluated_on date,
 answered_at timestamptz,
 answer jsonb CHECK(answer IS NULL OR jsonb_typeof(answer)='object'),
 suppressed_until timestamptz,
 reopened_by_evidence_id uuid,
 applied_rule_id uuid,
 context_packet_id uuid,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(owner_scope_id,id),
 FOREIGN KEY(owner_scope_id,reopened_by_evidence_id) REFERENCES source_items(owner_scope_id,id),
 FOREIGN KEY(owner_scope_id,applied_rule_id) REFERENCES learned_approval_rules(owner_scope_id,id),
 FOREIGN KEY(owner_scope_id,context_packet_id) REFERENCES context_packets(owner_scope_id,id),
 CONSTRAINT clarification_cards_asked CHECK(status<>'ASKED' OR (asked_at IS NOT NULL AND asked_on IS NOT NULL)),
 CONSTRAINT clarification_cards_resolved CHECK(status<>'RESOLVED' OR answered_at IS NOT NULL),
 CONSTRAINT clarification_cards_answer CHECK((answer IS NULL)=(answered_at IS NULL))
);
CREATE UNIQUE INDEX clarification_cards_open_situation ON clarification_cards(owner_scope_id,situation_key) WHERE status NOT IN ('RESOLVED','CLEARED');
CREATE INDEX clarification_cards_asked ON clarification_cards(owner_scope_id,asked_on,sensitivity_scope);

-- Every interruption evaluation, with the policy inputs and the reason (PRD §19.4).
CREATE TABLE interruption_decisions (
 id uuid PRIMARY KEY,
 owner_scope_id uuid NOT NULL REFERENCES owner_scopes(id),
 clarification_card_id uuid NOT NULL,
 candidate_ambiguity_id uuid NOT NULL,
 ambiguity_kind text NOT NULL CHECK(ambiguity_kind IN ('UNCONFIRMED_INTERPRETATION','CONTESTED_BELIEF','CONFLICTING_VALUES')),
 policy_inputs jsonb NOT NULL CHECK(jsonb_typeof(policy_inputs)='object'
  AND policy_inputs ?& ARRAY['errorProbability','consequence','irreversibility','urgency','interruptionCost','budget']),
 decision text NOT NULL CHECK(decision IN ('ASK','BATCH','SUPPRESS')),
 reason text NOT NULL CHECK(reason ~ '^[A-Z][A-Z0-9_]{0,63}$'),
 owner_local_date date NOT NULL,
 policy_version text NOT NULL CHECK(policy_version ~ '^[a-z][a-z0-9_.-]{0,63}$'),
 decided_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(owner_scope_id,id),
 FOREIGN KEY(owner_scope_id,clarification_card_id) REFERENCES clarification_cards(owner_scope_id,id)
);
CREATE INDEX interruption_decisions_card ON interruption_decisions(owner_scope_id,clarification_card_id,decided_at DESC);

-- The weekly review (PRD §39), grounded in the packet it was composed from.
CREATE TABLE weekly_reviews (
 id uuid PRIMARY KEY,
 owner_scope_id uuid NOT NULL REFERENCES owner_scopes(id),
 week_start date NOT NULL,
 week_end date NOT NULL CHECK(week_end = week_start + 6),
 time_zone text NOT NULL CHECK(length(time_zone) BETWEEN 1 AND 64),
 priority_versus_calendar jsonb NOT NULL CHECK(jsonb_typeof(priority_versus_calendar)='object'),
 commitments_versus_resolutions jsonb NOT NULL CHECK(jsonb_typeof(commitments_versus_resolutions)='object'),
 decisions_versus_outcomes jsonb NOT NULL CHECK(jsonb_typeof(decisions_versus_outcomes)='object'),
 planned_versus_observed_spending jsonb NOT NULL CHECK(jsonb_typeof(planned_versus_observed_spending)='object'),
 material_changes jsonb NOT NULL CHECK(jsonb_typeof(material_changes)='object'),
 repeated_postponement jsonb NOT NULL CHECK(jsonb_typeof(repeated_postponement)='object'),
 behavioral_observation_ids uuid[] NOT NULL DEFAULT '{}',
 context_packet_id uuid NOT NULL,
 packet_hash text NOT NULL CHECK(packet_hash ~ '^[a-f0-9]{64}$'),
 manifest jsonb NOT NULL CHECK(jsonb_typeof(manifest)='object'),
 statement_count integer NOT NULL CHECK(statement_count >= 0),
 review_version text NOT NULL CHECK(review_version ~ '^[a-z][a-z0-9_.-]{0,63}$'),
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(owner_scope_id,id),
 FOREIGN KEY(owner_scope_id,context_packet_id) REFERENCES context_packets(owner_scope_id,id)
);
CREATE INDEX weekly_reviews_owner ON weekly_reviews(owner_scope_id,week_start,created_at DESC);

-- A behavioral observation (PRD §39): never from one episode.
CREATE TABLE behavioral_observations (
 id uuid PRIMARY KEY,
 owner_scope_id uuid NOT NULL REFERENCES owner_scopes(id),
 pattern_kind text NOT NULL CHECK(pattern_kind IN ('REPEATED_POSTPONEMENT')),
 statement text NOT NULL CHECK(length(statement) BETWEEN 1 AND 1000),
 supporting_episode_ids uuid[] NOT NULL CHECK(cardinality(supporting_episode_ids) >= 2),
 supporting_episodes jsonb NOT NULL CHECK(jsonb_typeof(supporting_episodes)='array' AND jsonb_array_length(supporting_episodes) >= 2),
 counterexample_search jsonb NOT NULL CHECK(jsonb_typeof(counterexample_search)='object'
  AND counterexample_search ?& ARRAY['searched','counterexamplesFound','counterexampleIds']),
 observation_window_start timestamptz NOT NULL,
 observation_window_end timestamptz NOT NULL,
 confidence numeric NOT NULL CHECK(confidence >= 0 AND confidence <= 1),
 review_or_expiry_date date NOT NULL,
 context_packet_id uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(owner_scope_id,id),
 FOREIGN KEY(owner_scope_id,context_packet_id) REFERENCES context_packets(owner_scope_id,id),
 CONSTRAINT behavioral_observations_window CHECK(observation_window_end > observation_window_start),
 CONSTRAINT behavioral_observations_review_after_window CHECK(review_or_expiry_date >= observation_window_end::date)
);
CREATE INDEX behavioral_observations_owner ON behavioral_observations(owner_scope_id,created_at DESC);

ALTER TABLE attention_budgets ENABLE ROW LEVEL SECURITY;
ALTER TABLE attention_budgets FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_read ON attention_budgets FOR SELECT TO unai_app
 USING(unai_private.has_owner_access(owner_scope_id) AND unai_private.memory_purpose(ARRAY['memory.inbox','settings.attention']));
CREATE POLICY owner_configure ON attention_budgets FOR INSERT TO unai_app
 WITH CHECK(unai_private.has_owner_access(owner_scope_id) AND unai_private.memory_purpose(ARRAY['settings.attention'])
 AND updated_by_user_id=unai_private.actor_id());
CREATE POLICY owner_reconfigure ON attention_budgets FOR UPDATE TO unai_app
 USING(unai_private.has_owner_access(owner_scope_id) AND unai_private.memory_purpose(ARRAY['settings.attention']))
 WITH CHECK(unai_private.has_owner_access(owner_scope_id) AND unai_private.memory_purpose(ARRAY['settings.attention'])
 AND updated_by_user_id=unai_private.actor_id());
GRANT SELECT,INSERT ON attention_budgets TO unai_app;
GRANT UPDATE(max_cards_per_day,max_cards_per_sensitivity_scope_per_day,repeat_question_suppression_days,updated_by_user_id,updated_at)
 ON attention_budgets TO unai_app;

ALTER TABLE learned_approval_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE learned_approval_rules FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_read ON learned_approval_rules FOR SELECT TO unai_app
 USING(unai_private.has_owner_access(owner_scope_id) AND unai_private.memory_purpose(ARRAY['memory.inbox','approval.rules']));
-- The inbox may only *propose*: a rule it writes is PROPOSED and approved by nobody.
CREATE POLICY owner_propose ON learned_approval_rules FOR INSERT TO unai_app
 WITH CHECK(unai_private.has_owner_access(owner_scope_id) AND unai_private.memory_purpose(ARRAY['memory.inbox'])
 AND status='PROPOSED' AND approved_by_user_id IS NULL AND approved_at IS NULL AND revoked_at IS NULL);
-- Only the rules surface approves or revokes, and an approval names the session's
-- own actor: nothing else can consent on the owner's behalf.
CREATE POLICY owner_decide ON learned_approval_rules FOR UPDATE TO unai_app
 USING(unai_private.has_owner_access(owner_scope_id) AND unai_private.memory_purpose(ARRAY['approval.rules']))
 WITH CHECK(unai_private.has_owner_access(owner_scope_id) AND unai_private.memory_purpose(ARRAY['approval.rules'])
 AND (status<>'APPROVED' OR approved_by_user_id=unai_private.actor_id()));
GRANT SELECT,INSERT ON learned_approval_rules TO unai_app;
GRANT UPDATE(status,approved_by_user_id,approved_at,revoked_at) ON learned_approval_rules TO unai_app;

CREATE FUNCTION unai_private.learned_rule_transition() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF NEW.id<>OLD.id OR NEW.owner_scope_id<>OLD.owner_scope_id OR NEW.rule_text<>OLD.rule_text OR NEW.scope<>OLD.scope
  OR NEW.rule_signature<>OLD.rule_signature OR NEW.proposed_from_card_ids<>OLD.proposed_from_card_ids
  OR NEW.proposed_at<>OLD.proposed_at THEN
  RAISE EXCEPTION 'LEARNED_RULE_IDENTITY_IMMUTABLE' USING ERRCODE='55000';
 END IF;
 IF NOT ((OLD.status='PROPOSED' AND NEW.status IN ('APPROVED','REVOKED'))
   OR (OLD.status='APPROVED' AND NEW.status='REVOKED')) THEN
  RAISE EXCEPTION 'LEARNED_RULE_TRANSITION_REFUSED' USING ERRCODE='55000';
 END IF;
 IF OLD.status='APPROVED' AND (NEW.approved_at IS DISTINCT FROM OLD.approved_at
   OR NEW.approved_by_user_id IS DISTINCT FROM OLD.approved_by_user_id) THEN
  RAISE EXCEPTION 'LEARNED_RULE_TRANSITION_REFUSED' USING ERRCODE='55000';
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION unai_private.learned_rule_transition() FROM PUBLIC;
CREATE TRIGGER learned_approval_rules_transition BEFORE UPDATE ON learned_approval_rules
 FOR EACH ROW EXECUTE FUNCTION unai_private.learned_rule_transition();

ALTER TABLE clarification_cards ENABLE ROW LEVEL SECURITY;
ALTER TABLE clarification_cards FORCE ROW LEVEL SECURITY;
-- The rules surface reads the cards a rule resolved: that is the rule's history.
CREATE POLICY owner_read ON clarification_cards FOR SELECT TO unai_app
 USING(unai_private.has_owner_access(owner_scope_id) AND unai_private.memory_purpose(ARRAY['memory.inbox','approval.rules']));
CREATE POLICY owner_open ON clarification_cards FOR INSERT TO unai_app
 WITH CHECK(unai_private.has_owner_access(owner_scope_id) AND unai_private.memory_purpose(ARRAY['memory.inbox']));
CREATE POLICY owner_evaluate ON clarification_cards FOR UPDATE TO unai_app
 USING(unai_private.has_owner_access(owner_scope_id) AND unai_private.memory_purpose(ARRAY['memory.inbox']))
 WITH CHECK(unai_private.has_owner_access(owner_scope_id) AND unai_private.memory_purpose(ARRAY['memory.inbox']));
GRANT SELECT,INSERT ON clarification_cards TO unai_app;
GRANT UPDATE(title,facts,why_it_matters,choices,grouped_ambiguity_ids,ambiguities,sensitivity_scope,rule_signature,rule_scope,
 known_evidence_ids,evidence_ids,policy_inputs,status,asked_at,asked_on,last_evaluated_on,answered_at,answer,suppressed_until,
 reopened_by_evidence_id,applied_rule_id,context_packet_id,updated_at) ON clarification_cards TO unai_app;

-- A card keeps its identity, its owner and its situation for as long as it exists,
-- and a resolved card is history: it is never reopened in place.
CREATE FUNCTION unai_private.clarification_card_identity() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF NEW.id<>OLD.id OR NEW.owner_scope_id<>OLD.owner_scope_id OR NEW.situation_key<>OLD.situation_key
  OR NEW.situation_kind<>OLD.situation_kind OR NEW.created_at<>OLD.created_at THEN
  RAISE EXCEPTION 'CLARIFICATION_CARD_IDENTITY_IMMUTABLE' USING ERRCODE='55000';
 END IF;
 IF OLD.status IN ('RESOLVED','CLEARED') THEN
  RAISE EXCEPTION 'CLARIFICATION_CARD_RESOLVED' USING ERRCODE='55000';
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION unai_private.clarification_card_identity() FROM PUBLIC;
CREATE TRIGGER clarification_cards_identity BEFORE UPDATE ON clarification_cards
 FOR EACH ROW EXECUTE FUNCTION unai_private.clarification_card_identity();

ALTER TABLE interruption_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE interruption_decisions FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_read ON interruption_decisions FOR SELECT TO unai_app
 USING(unai_private.has_owner_access(owner_scope_id) AND unai_private.memory_purpose(ARRAY['memory.inbox','approval.rules'])
 AND EXISTS(SELECT 1 FROM clarification_cards c WHERE c.owner_scope_id=interruption_decisions.owner_scope_id AND c.id=clarification_card_id));
CREATE POLICY owner_log ON interruption_decisions FOR INSERT TO unai_app
 WITH CHECK(unai_private.has_owner_access(owner_scope_id) AND unai_private.memory_purpose(ARRAY['memory.inbox'])
 AND EXISTS(SELECT 1 FROM clarification_cards c WHERE c.owner_scope_id=interruption_decisions.owner_scope_id AND c.id=clarification_card_id));
GRANT SELECT,INSERT ON interruption_decisions TO unai_app;
CREATE TRIGGER interruption_decisions_immutable BEFORE UPDATE ON interruption_decisions
 FOR EACH ROW EXECUTE FUNCTION unai_private.canonicalization_record_immutable();

ALTER TABLE weekly_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE weekly_reviews FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_read ON weekly_reviews FOR SELECT TO unai_app
 USING(unai_private.has_owner_access(owner_scope_id) AND unai_private.memory_purpose(ARRAY['review.weekly']));
CREATE POLICY owner_record ON weekly_reviews FOR INSERT TO unai_app
 WITH CHECK(unai_private.has_owner_access(owner_scope_id) AND unai_private.memory_purpose(ARRAY['review.weekly']));
GRANT SELECT,INSERT ON weekly_reviews TO unai_app;
CREATE TRIGGER weekly_reviews_immutable BEFORE UPDATE ON weekly_reviews
 FOR EACH ROW EXECUTE FUNCTION unai_private.canonicalization_record_immutable();

ALTER TABLE behavioral_observations ENABLE ROW LEVEL SECURITY;
ALTER TABLE behavioral_observations FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_read ON behavioral_observations FOR SELECT TO unai_app
 USING(unai_private.has_owner_access(owner_scope_id) AND unai_private.memory_purpose(ARRAY['review.weekly']));
CREATE POLICY owner_record ON behavioral_observations FOR INSERT TO unai_app
 WITH CHECK(unai_private.has_owner_access(owner_scope_id) AND unai_private.memory_purpose(ARRAY['review.weekly']));
GRANT SELECT,INSERT ON behavioral_observations TO unai_app;
CREATE TRIGGER behavioral_observations_immutable BEFORE UPDATE ON behavioral_observations
 FOR EACH ROW EXECUTE FUNCTION unai_private.canonicalization_record_immutable();

-- The registry reader, answering exactly what migration 0019 made it answer, with
-- its locks taken in the order the snapshot is written and guarded: releases,
-- then contracts. The inbox and the review add broker reads, and every broker
-- read asks this question; reading contracts first let a reader hold the
-- contracts lock while waiting on releases, which deadlocks against anything
-- that locks releases then contracts (a publish, or the refused TRUNCATE the
-- snapshot suite asserts). Same purposes, same inputs, same boolean (ADR 0029 §10).
CREATE OR REPLACE FUNCTION unai_private.registry_contract_present(release_id uuid, contract text, kind text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT unai_private.owner_id() IS NOT NULL
  AND current_setting('unai.purpose',true) = ANY(ARRAY['memory.govern','memory.canonicalize','memory.inspect','memory.read'])
  AND EXISTS(SELECT 1 FROM public.registry_releases r
    JOIN public.registry_contracts c ON c.registry_release_id=r.id
    WHERE r.id=release_id AND r.lifecycle='RELEASED' AND c.contract_id=contract AND c.contract_kind=kind)
$$;
REVOKE ALL ON FUNCTION unai_private.registry_contract_present(uuid,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION unai_private.registry_contract_present(uuid,text,text) TO unai_app;
