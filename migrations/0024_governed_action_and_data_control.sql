-- Governed action and the data-control surface (design entities `drafts`,
-- `recommendation_artifacts`, `action_history`, `memory_summaries` and
-- `retention_and_deletion_requests`; PRD §7.8, §8.4, §27, §29.3, §30.7, §33.13,
-- §60). ADR 0030 records the decisions below before the code. The attention
-- budget the Permissions surface shows and changes is migration 0023's
-- `attention_budgets`, under its own `settings.attention` purpose.
--
-- Five rules are carried by the schema rather than by application code:
--
--  1. V0 grants no external write. A plugin capability whose access kind is
--     WRITE may be listed and never granted; only a DRAFT capability can be.
--  2. A draft is never executed. `drafts.status` has no executed value, and an
--     action-history entry about a draft may only be DRAFTED or REQUESTED_APPROVAL.
--  3. An execution fact needs a receipt. EXECUTED and RECEIVED_CONFIRMATION
--     entries must name an authoritative receipt evidence row.
--  4. A recommendation is RECOMMENDED and nothing else, and a blocked one can
--     never be accepted.
--  5. Deletion erases. Under `data.delete` the evidence row becomes a tombstone
--     with no content, its derivatives are deleted, and the few rows that are
--     someone else's history are erased in place -- each immutability trigger
--     admits exactly that erasure and nothing else.

-- ---------------------------------------------------------------------------
-- Plugin capabilities (PRD §27.1): one row per discrete capability.
CREATE TABLE plugin_capability_grants (
 id uuid PRIMARY KEY,
 owner_scope_id uuid NOT NULL REFERENCES owner_scopes(id),
 capability_id text NOT NULL CHECK(capability_id ~ '^[a-z][a-z0-9_]{0,31}\.[a-z][a-z0-9_]{0,63}$'),
 access_kind text NOT NULL CHECK(access_kind IN ('DRAFT','WRITE')),
 risk_class text NOT NULL CHECK(risk_class IN ('LOW','MEDIUM','HIGH')),
 granted boolean NOT NULL,
 granted_at timestamptz,
 revoked_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(owner_scope_id,id),
 UNIQUE(owner_scope_id,capability_id),
 -- V0 excludes every external write: sending, calendar writes, money movement
 -- and trading may be shown and never granted (CRT-CON-08-A).
 CONSTRAINT plugin_capability_grants_no_external_write CHECK(NOT(granted AND access_kind='WRITE')),
 CONSTRAINT plugin_capability_grants_state CHECK(
  CASE WHEN granted THEN granted_at IS NOT NULL AND revoked_at IS NULL
  ELSE (granted_at IS NULL)=(revoked_at IS NULL) END)
);
ALTER TABLE plugin_capability_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE plugin_capability_grants FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_read ON plugin_capability_grants FOR SELECT TO unai_app
 USING(unai_private.has_owner_access(owner_scope_id)
 AND current_setting('unai.purpose',true) IN ('permissions.read','permissions.manage','action.draft','action.execute','data.export'));
CREATE POLICY owner_grant ON plugin_capability_grants FOR INSERT TO unai_app
 WITH CHECK(unai_private.has_owner_access(owner_scope_id) AND current_setting('unai.purpose',true)='permissions.manage');
CREATE POLICY owner_regrant ON plugin_capability_grants FOR UPDATE TO unai_app
 USING(unai_private.has_owner_access(owner_scope_id) AND current_setting('unai.purpose',true)='permissions.manage')
 WITH CHECK(unai_private.has_owner_access(owner_scope_id) AND current_setting('unai.purpose',true)='permissions.manage');
GRANT SELECT,INSERT,UPDATE ON plugin_capability_grants TO unai_app;

CREATE FUNCTION unai_private.plugin_grant_identity() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
 BEGIN
  IF NEW.id<>OLD.id OR NEW.owner_scope_id<>OLD.owner_scope_id OR NEW.capability_id<>OLD.capability_id
   OR NEW.access_kind<>OLD.access_kind OR NEW.risk_class<>OLD.risk_class OR NEW.created_at<>OLD.created_at THEN
   RAISE EXCEPTION 'PLUGIN_GRANT_IDENTITY_IMMUTABLE' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
 END
$$;
REVOKE ALL ON FUNCTION unai_private.plugin_grant_identity() FROM PUBLIC;
CREATE TRIGGER plugin_grant_identity BEFORE UPDATE ON plugin_capability_grants
 FOR EACH ROW EXECUTE FUNCTION unai_private.plugin_grant_identity();

-- ---------------------------------------------------------------------------
-- Recommendations (PRD §24.2, §60): stored with RECOMMENDED semantics, never as
-- user intent, a claim or an executed fact.
CREATE TABLE recommendation_artifacts (
 id uuid PRIMARY KEY,
 owner_scope_id uuid NOT NULL REFERENCES owner_scopes(id),
 semantics text NOT NULL DEFAULT 'RECOMMENDED' CHECK(semantics='RECOMMENDED'),
 recommendation_text text NOT NULL CHECK(length(recommendation_text) BETWEEN 1 AND 2000),
 recommended_action_kind text NOT NULL
  CHECK(recommended_action_kind IN ('OTHER','DRAFT','EMAIL_SEND','CALENDAR_CREATE','CALENDAR_UPDATE','MONEY_MOVEMENT','TRADE')),
 action_risk text NOT NULL CHECK(action_risk IN ('LOW','MEDIUM','HIGH')),
 -- A pointer for the inspector, never a foreign key: the recommendation is not
 -- support for that proposition and must not hold it in place.
 recommended_proposition_id uuid,
 supporting_packet_id uuid,
 -- What the recommendation rests on, as labels and identifiers only, so the
 -- detail screen can keep evidence, inference and recommendation apart.
 supporting_evidence_ids uuid[] NOT NULL DEFAULT '{}' CHECK(cardinality(supporting_evidence_ids)<=200),
 supporting_assessment text NOT NULL CHECK(supporting_assessment IN ('ACCEPTED','PROVISIONAL','CONTESTED','NONE')),
 projection_complete boolean NOT NULL,
 status text NOT NULL CHECK(status IN ('ACTIVE','BLOCKED')),
 requires_confirmation boolean NOT NULL DEFAULT false,
 policy_decision_id uuid,
 blocked_reason text CHECK(blocked_reason IS NULL OR blocked_reason ~ '^[A-Z][A-Z0-9_]{0,95}$'),
 user_response text NOT NULL DEFAULT 'NONE'
  CHECK(user_response IN ('NONE','ACCEPTED_AS_INTENT_TO_PREPARE','DISMISSED','SNOOZED')),
 response_evidence_id uuid,
 responded_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(owner_scope_id,id),
 FOREIGN KEY(owner_scope_id,supporting_packet_id) REFERENCES context_packets(owner_scope_id,id),
 FOREIGN KEY(owner_scope_id,policy_decision_id) REFERENCES policy_decisions(owner_scope_id,id),
 FOREIGN KEY(owner_scope_id,response_evidence_id) REFERENCES source_items(owner_scope_id,id),
 CONSTRAINT recommendation_blocked_explained CHECK((status='BLOCKED')=(blocked_reason IS NOT NULL)),
 -- A recommendation withheld for unsettled memory can be dismissed, never acted on.
 CONSTRAINT recommendation_blocked_not_accepted CHECK(status='ACTIVE' OR user_response IN ('NONE','DISMISSED')),
 CONSTRAINT recommendation_response_recorded CHECK((user_response='NONE')=(responded_at IS NULL)),
 -- An acceptance is the owner's own words, stored as evidence.
 CONSTRAINT recommendation_acceptance_sourced CHECK(user_response<>'ACCEPTED_AS_INTENT_TO_PREPARE' OR response_evidence_id IS NOT NULL)
);
CREATE INDEX recommendation_artifacts_owner ON recommendation_artifacts(owner_scope_id,created_at DESC);
ALTER TABLE recommendation_artifacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE recommendation_artifacts FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_read ON recommendation_artifacts FOR SELECT TO unai_app
 USING(unai_private.has_owner_access(owner_scope_id)
 AND current_setting('unai.purpose',true) IN ('action.read','action.recommend','action.draft','action.receipt','data.export'));
CREATE POLICY owner_recommend ON recommendation_artifacts FOR INSERT TO unai_app
 WITH CHECK(unai_private.has_owner_access(owner_scope_id) AND current_setting('unai.purpose',true)='action.recommend');
CREATE POLICY owner_respond ON recommendation_artifacts FOR UPDATE TO unai_app
 USING(unai_private.has_owner_access(owner_scope_id) AND current_setting('unai.purpose',true)='action.recommend')
 WITH CHECK(unai_private.has_owner_access(owner_scope_id) AND current_setting('unai.purpose',true)='action.recommend');
GRANT SELECT,INSERT ON recommendation_artifacts TO unai_app;
GRANT UPDATE(user_response,response_evidence_id,responded_at) ON recommendation_artifacts TO unai_app;

-- The owner answers a recommendation once; the recommendation itself never changes.
CREATE FUNCTION unai_private.recommendation_response_only() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
 BEGIN
  IF (to_jsonb(NEW)-'user_response'-'response_evidence_id'-'responded_at')
     <>(to_jsonb(OLD)-'user_response'-'response_evidence_id'-'responded_at') THEN
   RAISE EXCEPTION 'RECOMMENDATION_IMMUTABLE' USING ERRCODE='55000';
  END IF;
  IF OLD.user_response NOT IN ('NONE','SNOOZED') THEN
   RAISE EXCEPTION 'RECOMMENDATION_ALREADY_ANSWERED' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
 END
$$;
REVOKE ALL ON FUNCTION unai_private.recommendation_response_only() FROM PUBLIC;
CREATE TRIGGER recommendation_response_only BEFORE UPDATE ON recommendation_artifacts
 FOR EACH ROW EXECUTE FUNCTION unai_private.recommendation_response_only();

-- ---------------------------------------------------------------------------
-- Drafts (PRD §8.4, §27.5): a Uai artifact, created only under a recorded ALLOW.
CREATE TABLE drafts (
 id uuid PRIMARY KEY,
 owner_scope_id uuid NOT NULL REFERENCES owner_scopes(id),
 draft_kind text NOT NULL CHECK(draft_kind IN ('EMAIL','CALENDAR_EVENT')),
 capability_id text NOT NULL CHECK(capability_id IN ('gmail.create_draft','calendar.create_draft')),
 content jsonb NOT NULL CHECK(jsonb_typeof(content)='object'),
 recommendation_id uuid,
 supporting_packet_id uuid NOT NULL,
 -- The EvaluateMemoryAction decision that allowed it. Required: a draft with no
 -- recorded allowance is unrepresentable (CRT-CON-08-A).
 policy_decision_id uuid NOT NULL,
 status text NOT NULL DEFAULT 'CREATED' CHECK(status IN ('CREATED','AWAITING_APPROVAL','APPROVED','DISCARDED')),
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(owner_scope_id,id),
 FOREIGN KEY(owner_scope_id,recommendation_id) REFERENCES recommendation_artifacts(owner_scope_id,id),
 FOREIGN KEY(owner_scope_id,supporting_packet_id) REFERENCES context_packets(owner_scope_id,id),
 FOREIGN KEY(owner_scope_id,policy_decision_id) REFERENCES policy_decisions(owner_scope_id,id)
);
CREATE INDEX drafts_owner ON drafts(owner_scope_id,created_at DESC);
ALTER TABLE drafts ENABLE ROW LEVEL SECURITY;
ALTER TABLE drafts FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_read ON drafts FOR SELECT TO unai_app
 USING(unai_private.has_owner_access(owner_scope_id)
 AND current_setting('unai.purpose',true) IN ('action.read','action.draft','data.export'));
CREATE POLICY owner_draft ON drafts FOR INSERT TO unai_app
 WITH CHECK(unai_private.has_owner_access(owner_scope_id) AND current_setting('unai.purpose',true)='action.draft');
CREATE POLICY owner_decide ON drafts FOR UPDATE TO unai_app
 USING(unai_private.has_owner_access(owner_scope_id) AND current_setting('unai.purpose',true)='action.draft')
 WITH CHECK(unai_private.has_owner_access(owner_scope_id) AND current_setting('unai.purpose',true)='action.draft');
GRANT SELECT,INSERT ON drafts TO unai_app;
GRANT UPDATE(status,updated_at) ON drafts TO unai_app;

-- CREATED -> AWAITING_APPROVAL -> APPROVED, and DISCARDED from either open
-- state. Approval is the last step V0 has: there is no executed status to reach.
CREATE FUNCTION unai_private.draft_transition() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
 BEGIN
  IF (to_jsonb(NEW)-'status'-'updated_at')<>(to_jsonb(OLD)-'status'-'updated_at') THEN
   RAISE EXCEPTION 'DRAFT_IMMUTABLE' USING ERRCODE='55000';
  END IF;
  IF NOT ((OLD.status='CREATED' AND NEW.status IN ('AWAITING_APPROVAL','DISCARDED'))
   OR (OLD.status='AWAITING_APPROVAL' AND NEW.status IN ('APPROVED','DISCARDED'))) THEN
   RAISE EXCEPTION 'DRAFT_TRANSITION_REFUSED' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
 END
$$;
REVOKE ALL ON FUNCTION unai_private.draft_transition() FROM PUBLIC;
CREATE TRIGGER draft_transition BEFORE UPDATE ON drafts FOR EACH ROW EXECUTE FUNCTION unai_private.draft_transition();

-- ---------------------------------------------------------------------------
-- The action history (PRD §8.4, §37.8): every entry is exactly one stage.
CREATE TABLE action_history (
 id uuid PRIMARY KEY,
 owner_scope_id uuid NOT NULL REFERENCES owner_scopes(id),
 stage text NOT NULL CHECK(stage IN ('OBSERVED','SUGGESTED','DRAFTED','REQUESTED_APPROVAL','EXECUTED','RECEIVED_CONFIRMATION')),
 action_kind text NOT NULL
  CHECK(action_kind IN ('DRAFT','EMAIL_SEND','CALENDAR_CREATE','CALENDAR_UPDATE','MONEY_MOVEMENT','TRADE','OTHER')),
 subject_object_type text NOT NULL CHECK(subject_object_type IN ('recommendation','draft','evidence')),
 subject_object_id uuid NOT NULL,
 recommendation_id uuid,
 policy_decision_id uuid,
 receipt_evidence_id uuid,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(owner_scope_id,id),
 FOREIGN KEY(owner_scope_id,recommendation_id) REFERENCES recommendation_artifacts(owner_scope_id,id),
 FOREIGN KEY(owner_scope_id,policy_decision_id) REFERENCES policy_decisions(owner_scope_id,id),
 FOREIGN KEY(owner_scope_id,receipt_evidence_id) REFERENCES source_items(owner_scope_id,id),
 -- Only an authoritative external receipt establishes execution (PRD §60).
 CONSTRAINT action_history_execution_receipted
  CHECK(stage NOT IN ('EXECUTED','RECEIVED_CONFIRMATION') OR receipt_evidence_id IS NOT NULL),
 -- A draft is never labelled executed (CRT-UX-13-A).
 CONSTRAINT action_history_draft_never_executed
  CHECK(subject_object_type<>'draft' OR stage IN ('DRAFTED','REQUESTED_APPROVAL')),
 -- A suggestion is a recommendation's stage and nothing else's.
 CONSTRAINT action_history_suggestion_is_recommendation
  CHECK(stage<>'SUGGESTED' OR subject_object_type='recommendation')
);
CREATE INDEX action_history_owner ON action_history(owner_scope_id,created_at DESC,id);
ALTER TABLE action_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE action_history FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_read ON action_history FOR SELECT TO unai_app
 USING(unai_private.has_owner_access(owner_scope_id)
 AND current_setting('unai.purpose',true) IN ('action.read','action.draft','action.recommend','action.receipt','data.export'));
CREATE POLICY owner_append ON action_history FOR INSERT TO unai_app
 WITH CHECK(unai_private.has_owner_access(owner_scope_id)
 AND current_setting('unai.purpose',true) IN ('action.draft','action.recommend','action.receipt'));
GRANT SELECT,INSERT ON action_history TO unai_app;
-- The record is append-only, and every entry names something that exists. The
-- receipt behind an execution fact must be a live TOOL_RECEIPT evidence item of
-- the same owner: an owner statement, a connector item or a deleted item is not
-- an authoritative receipt. SECURITY DEFINER because the entry is written under
-- an action purpose, which the evidence row policies rightly do not admit; it
-- reads only rows of the entry's own owner scope, which the INSERT policy has
-- already checked, and answers nothing but a refusal.
CREATE FUNCTION unai_private.action_history_subject() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
 BEGIN
  IF NEW.receipt_evidence_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.source_items s
    WHERE s.owner_scope_id=NEW.owner_scope_id AND s.id=NEW.receipt_evidence_id
      AND s.source_type='TOOL_RECEIPT' AND s.deleted_at IS NULL) THEN
   RAISE EXCEPTION 'ACTION_RECEIPT_NOT_AUTHORITATIVE' USING ERRCODE='23514';
  END IF;
  IF (NEW.subject_object_type='evidence' AND NOT EXISTS(SELECT 1 FROM public.source_items s
      WHERE s.owner_scope_id=NEW.owner_scope_id AND s.id=NEW.subject_object_id AND s.deleted_at IS NULL))
   OR (NEW.subject_object_type='draft' AND NOT EXISTS(SELECT 1 FROM public.drafts d
      WHERE d.owner_scope_id=NEW.owner_scope_id AND d.id=NEW.subject_object_id))
   OR (NEW.subject_object_type='recommendation' AND NOT EXISTS(SELECT 1 FROM public.recommendation_artifacts r
      WHERE r.owner_scope_id=NEW.owner_scope_id AND r.id=NEW.subject_object_id)) THEN
   RAISE EXCEPTION 'ACTION_SUBJECT_NOT_FOUND' USING ERRCODE='23503';
  END IF;
  RETURN NEW;
 END
$$;
REVOKE ALL ON FUNCTION unai_private.action_history_subject() FROM PUBLIC;
CREATE TRIGGER action_history_subject BEFORE INSERT ON action_history
 FOR EACH ROW EXECUTE FUNCTION unai_private.action_history_subject();
CREATE TRIGGER action_history_immutable BEFORE UPDATE ON action_history
 FOR EACH ROW EXECUTE FUNCTION unai_private.canonicalization_record_immutable();

-- ---------------------------------------------------------------------------
-- The owner's settings, each read by the next operation that needs it.
CREATE TABLE retention_settings (
 owner_scope_id uuid NOT NULL REFERENCES owner_scopes(id),
 source_type text NOT NULL CHECK(source_type ~ '^[A-Z][A-Z0-9_]{0,63}$'),
 -- Null keeps the item until the owner deletes it.
 raw_retention_days integer CHECK(raw_retention_days IS NULL OR raw_retention_days BETWEEN 1 AND 36500),
 derived_retention_days integer CHECK(derived_retention_days IS NULL OR derived_retention_days BETWEEN 1 AND 36500),
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(owner_scope_id,source_type)
);
CREATE TABLE domain_sensitivity_settings (
 owner_scope_id uuid NOT NULL REFERENCES owner_scopes(id),
 source_type text NOT NULL CHECK(source_type IN ('CONVERSATION','GMAIL','GOOGLE_CALENDAR','GITHUB','DOCUMENT')),
 sensitivity text NOT NULL CHECK(sensitivity IN ('NORMAL','PRIVATE','RESTRICTED')),
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(owner_scope_id,source_type)
);
ALTER TABLE retention_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE retention_settings FORCE ROW LEVEL SECURITY;
ALTER TABLE domain_sensitivity_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE domain_sensitivity_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_read ON retention_settings FOR SELECT TO unai_app
 USING(unai_private.has_owner_access(owner_scope_id)
 AND current_setting('unai.purpose',true) IN ('permissions.read','permissions.manage','data.export','data.delete'));
-- A sync and an upload read the level they store at; nothing else needs it.
CREATE POLICY owner_read ON domain_sensitivity_settings FOR SELECT TO unai_app
 USING(unai_private.has_owner_access(owner_scope_id)
 AND current_setting('unai.purpose',true) IN ('permissions.read','permissions.manage','data.export','connector.sync','evidence.ingest'));
DO $$
DECLARE t text;
BEGIN
 FOREACH t IN ARRAY ARRAY['retention_settings','domain_sensitivity_settings'] LOOP
  EXECUTE format('CREATE POLICY owner_set ON %I FOR INSERT TO unai_app WITH CHECK(unai_private.has_owner_access(owner_scope_id) AND current_setting(''unai.purpose'',true)=''permissions.manage'')', t);
  EXECUTE format('CREATE POLICY owner_change ON %I FOR UPDATE TO unai_app USING(unai_private.has_owner_access(owner_scope_id) AND current_setting(''unai.purpose'',true)=''permissions.manage'') WITH CHECK(unai_private.has_owner_access(owner_scope_id) AND current_setting(''unai.purpose'',true)=''permissions.manage'')', t);
  EXECUTE format('GRANT SELECT,INSERT,UPDATE ON %I TO unai_app', t);
 END LOOP;
END $$;
-- Clearing a retention rule returns the source type to "keep".
CREATE POLICY owner_clear ON retention_settings FOR DELETE TO unai_app
 USING(unai_private.has_owner_access(owner_scope_id) AND current_setting('unai.purpose',true)='permissions.manage');
GRANT DELETE ON retention_settings TO unai_app;

-- ---------------------------------------------------------------------------
-- Summaries (design entity `memory_summaries`): a derived cache that may never
-- be the only support for anything, and is deleted with what it summarises.
CREATE TABLE memory_summaries (
 id uuid PRIMARY KEY,
 owner_scope_id uuid NOT NULL REFERENCES owner_scopes(id),
 summary_text text NOT NULL CHECK(length(summary_text) BETWEEN 1 AND 20000),
 temporal_scope jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(temporal_scope)='object'),
 source_object_manifest jsonb NOT NULL CHECK(jsonb_typeof(source_object_manifest)='array'),
 -- Every object id the manifest names, so the deletion cascade finds a summary
 -- by any one of them without parsing JSON.
 source_object_ids uuid[] NOT NULL CHECK(cardinality(source_object_ids) BETWEEN 1 AND 1000),
 model_id text NOT NULL CHECK(length(model_id) BETWEEN 1 AND 128),
 prompt_version text NOT NULL CHECK(prompt_version ~ '^[a-z][a-z0-9_.-]{0,63}$'),
 registry_release_id uuid,
 generated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(owner_scope_id,id)
);
CREATE INDEX memory_summaries_sources ON memory_summaries USING gin(source_object_ids);
ALTER TABLE memory_summaries ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory_summaries FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_read ON memory_summaries FOR SELECT TO unai_app
 USING(unai_private.has_owner_access(owner_scope_id)
 AND current_setting('unai.purpose',true) IN ('memory.read','memory.inspect','memory.summarize'));
CREATE POLICY owner_summarize ON memory_summaries FOR INSERT TO unai_app
 WITH CHECK(unai_private.has_owner_access(owner_scope_id) AND current_setting('unai.purpose',true)='memory.summarize');
GRANT SELECT,INSERT ON memory_summaries TO unai_app;
CREATE TRIGGER memory_summaries_immutable BEFORE UPDATE ON memory_summaries
 FOR EACH ROW EXECUTE FUNCTION unai_private.canonicalization_record_immutable();

-- ---------------------------------------------------------------------------
-- Export, suppression, archive and deletion requests, with their receipts. The
-- receipt holds counts and identifiers, never a value (CRT-SEC-06-A).
CREATE TABLE retention_and_deletion_requests (
 id uuid PRIMARY KEY,
 owner_scope_id uuid NOT NULL REFERENCES owner_scopes(id),
 request_kind text NOT NULL CHECK(request_kind IN ('EXPORT','SUPPRESS','ARCHIVE','DELETE')),
 trigger text NOT NULL CHECK(trigger IN ('OWNER_REQUEST','RETENTION_POLICY')),
 scope jsonb NOT NULL CHECK(jsonb_typeof(scope)='object'),
 status text NOT NULL CHECK(status IN ('COMPLETED','FAILED')),
 cascade_receipt jsonb NOT NULL CHECK(jsonb_typeof(cascade_receipt)='object'),
 requested_by_user_id uuid NOT NULL,
 requested_at timestamptz NOT NULL,
 completed_at timestamptz,
 UNIQUE(owner_scope_id,id),
 FOREIGN KEY(owner_scope_id,requested_by_user_id) REFERENCES owner_scope_members(owner_scope_id,user_id),
 CONSTRAINT retention_request_completed CHECK((status='COMPLETED')=(completed_at IS NOT NULL))
);
CREATE INDEX retention_and_deletion_requests_owner ON retention_and_deletion_requests(owner_scope_id,requested_at DESC);
ALTER TABLE retention_and_deletion_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE retention_and_deletion_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_read ON retention_and_deletion_requests FOR SELECT TO unai_app
 USING(unai_private.has_owner_access(owner_scope_id)
 AND current_setting('unai.purpose',true) IN ('permissions.read','data.export','data.delete'));
CREATE POLICY owner_request ON retention_and_deletion_requests FOR INSERT TO unai_app
 WITH CHECK(unai_private.has_owner_access(owner_scope_id)
 AND current_setting('unai.purpose',true) IN ('data.export','data.delete')
 AND requested_by_user_id=unai_private.actor_id());
GRANT SELECT,INSERT ON retention_and_deletion_requests TO unai_app;
CREATE TRIGGER retention_and_deletion_requests_immutable BEFORE UPDATE ON retention_and_deletion_requests
 FOR EACH ROW EXECUTE FUNCTION unai_private.canonicalization_record_immutable();

-- ---------------------------------------------------------------------------
-- Export reads what the owner owns. The purpose is held to the owner boundary
-- and to nothing narrower -- an owner exports their own memory whatever data
-- purpose it was stored for -- and still to the declared sensitivity ceiling on
-- the evidence itself. Export writes nothing but its own request row.
CREATE POLICY data_export_read ON source_items FOR SELECT TO unai_app
 USING(unai_private.has_owner_access(owner_scope_id) AND deleted_at IS NULL
 AND current_setting('unai.purpose',true)='data.export'
 AND array_position(ARRAY['NORMAL','PRIVATE','RESTRICTED'],sensitivity)
  <= array_position(ARRAY['NORMAL','PRIVATE','RESTRICTED'],current_setting('unai.maximum_sensitivity',true)));
DO $$
DECLARE t text;
BEGIN
 FOREACH t IN ARRAY ARRAY['source_anchors','entities','entity_aliases','frame_instances','frame_instance_roles',
   'belief_slots','propositions','claims','belief_assessments','belief_support','claim_relations',
   'resolution_assertions','memory_links','memory_threads','memory_thread_members','derived_proposition_dependencies',
   'memory_summaries'] LOOP
  EXECUTE format('CREATE POLICY data_export_read ON %I FOR SELECT TO unai_app USING(unai_private.has_owner_access(owner_scope_id) AND current_setting(''unai.purpose'',true)=''data.export'')', t);
 END LOOP;
END $$;

-- The erasure reads the evidence rows it erases, tombstones included, and the
-- private object location, so the raw object can be deleted from storage in the
-- same transaction after the database erasure (ADR 0030 §8). It reads nothing
-- else through the row policies: the cascade itself runs in `erase_evidence`.
CREATE POLICY data_erasure_read ON source_items FOR SELECT TO unai_app
 USING(unai_private.has_owner_access(owner_scope_id) AND current_setting('unai.purpose',true)='data.delete');
CREATE POLICY data_erasure_read ON evidence_object_keys FOR SELECT TO unai_app
 USING(unai_private.has_owner_access(owner_scope_id) AND current_setting('unai.purpose',true)='data.delete');

-- The deletion cascade (PRD §30.7; CRT-SEC-06-A).
--
-- SECURITY DEFINER because it deletes rows from tables the application role holds
-- no DELETE grant on, and must keep holding none: the isolation suite asserts
-- that no canonical or evidence table is deletable by `unai_app` under any
-- purpose, and that stays true. The function is the one path, it is bounded to one
-- evidence item of one owner, it re-checks live membership and the purpose
-- itself, and it has no dynamic SQL.
--
-- What it removes: the item's anchors (its parsed content and lexical index),
-- triage decision, extraction runs with their model-call and match rows,
-- ingestion receipts, the aliases it sourced, every claim anchored in it or
-- extracted from it and everything naming those claims, and every proposition
-- left with no claim, no support and no dependency input -- to a fixpoint, so a
-- derived belief whose inputs are all gone goes too. What it erases in place:
-- the evidence row itself (a tombstone), its object key (`deleted_at`), the
-- owner's words on an overlay delta that quotes it, the operation payloads of any
-- belief transaction built on it, and every stored context packet that carried a
-- removed object. The records a read composed from memory -- Today briefing
-- editions and their items, clarification cards with their interruption
-- decisions, weekly reviews and behavioral observations (migrations 0022 and
-- 0023) -- are deleted whenever they name a removed object or a frame whose
-- projection row was removed: each can quote what was deleted, and none is
-- anyone's history. It answers counts and identifiers only.
CREATE FUNCTION unai_private.erase_evidence(owner uuid, evidence uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE
 raw_ref text;
 anchor_ids uuid[]; run_ids uuid[]; claim_ids uuid[]; proposition_ids uuid[] := '{}'; added uuid[];
 frame_ids uuid[]; link_ids uuid[]; resolution_ids uuid[]; erased_ids uuid[];
 edition_ids uuid[]; card_ids uuid[]; named_ids text[];
 counts jsonb := '{}'::jsonb; n integer; derived integer := 0;
BEGIN
 IF NOT unai_private.has_owner_access(owner) OR current_setting('unai.purpose',true) IS DISTINCT FROM 'data.delete' THEN
  RAISE EXCEPTION 'ERASURE_NOT_AUTHORIZED' USING ERRCODE='42501';
 END IF;
 SELECT raw_object_ref INTO raw_ref FROM public.source_items
  WHERE owner_scope_id=owner AND id=evidence AND deleted_at IS NULL FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'ERASURE_EVIDENCE_NOT_FOUND' USING ERRCODE='P0002'; END IF;

 SELECT coalesce(array_agg(id),'{}') INTO anchor_ids FROM public.source_anchors
  WHERE owner_scope_id=owner AND source_item_id=evidence;
 SELECT coalesce(array_agg(id),'{}') INTO run_ids FROM public.extraction_runs
  WHERE owner_scope_id=owner AND source_item_id=evidence;
 SELECT coalesce(array_agg(id),'{}') INTO claim_ids FROM public.claims
  WHERE owner_scope_id=owner AND (source_anchor_id=ANY(anchor_ids) OR extraction_run_id=ANY(run_ids));

 -- Unsupported beliefs, to a fixpoint: a proposition goes when it touched the
 -- removed claims or removed propositions and has nothing else left to stand on.
 LOOP
  SELECT coalesce(array_agg(p.id),'{}') INTO added FROM public.propositions p
   WHERE p.owner_scope_id=owner AND NOT (p.id=ANY(proposition_ids))
   AND (EXISTS(SELECT 1 FROM public.claims c WHERE c.owner_scope_id=owner AND c.proposition_id=p.id AND c.id=ANY(claim_ids))
    OR EXISTS(SELECT 1 FROM public.belief_support s WHERE s.owner_scope_id=owner AND s.proposition_id=p.id
      AND (s.claim_id=ANY(claim_ids) OR s.supporting_proposition_id=ANY(proposition_ids)))
    OR EXISTS(SELECT 1 FROM public.derived_proposition_dependencies d WHERE d.owner_scope_id=owner
      AND d.derived_proposition_id=p.id AND (d.input_claim_ids && claim_ids OR d.input_proposition_ids && proposition_ids)))
   AND NOT EXISTS(SELECT 1 FROM public.claims c WHERE c.owner_scope_id=owner AND c.proposition_id=p.id
      AND NOT (c.id=ANY(claim_ids)))
   AND NOT EXISTS(SELECT 1 FROM public.belief_support s WHERE s.owner_scope_id=owner AND s.proposition_id=p.id
      AND ((s.claim_id IS NOT NULL AND NOT (s.claim_id=ANY(claim_ids)))
        OR (s.supporting_proposition_id IS NOT NULL AND NOT (s.supporting_proposition_id=ANY(proposition_ids)))))
   AND NOT EXISTS(SELECT 1 FROM public.derived_proposition_dependencies d WHERE d.owner_scope_id=owner
      AND d.derived_proposition_id=p.id
      AND (EXISTS(SELECT 1 FROM unnest(d.input_claim_ids) AS i(id) WHERE NOT (i.id=ANY(claim_ids)))
        OR EXISTS(SELECT 1 FROM unnest(d.input_proposition_ids) AS i(id) WHERE NOT (i.id=ANY(proposition_ids)))));
  EXIT WHEN cardinality(added)=0;
  proposition_ids := proposition_ids || added;
 END LOOP;

 SELECT coalesce(array_agg(id),'{}') INTO link_ids FROM public.memory_links
  WHERE owner_scope_id=owner AND (from_object_id=ANY(claim_ids||proposition_ids||evidence)
   OR to_object_id=ANY(claim_ids||proposition_ids||evidence));
 SELECT coalesce(array_agg(id),'{}') INTO resolution_ids FROM public.resolution_assertions
  WHERE owner_scope_id=owner AND (claim_id=ANY(claim_ids) OR source_proposition_id=ANY(proposition_ids)
   OR target_proposition_id=ANY(proposition_ids) OR resolution_link_id=ANY(link_ids));
 -- A link that pointed at a removed resolution goes with it.
 link_ids := link_ids || coalesce((SELECT array_agg(id) FROM public.memory_links
  WHERE owner_scope_id=owner AND NOT (id=ANY(link_ids))
   AND (from_object_id=ANY(resolution_ids) OR to_object_id=ANY(resolution_ids))),'{}');

 -- Every frame whose projection row could carry a removed value.
 SELECT coalesce(array_agg(DISTINCT f),'{}') INTO frame_ids FROM (
   SELECT sl.frame_instance_id AS f FROM public.propositions p
    JOIN public.belief_slots sl ON sl.owner_scope_id=p.owner_scope_id AND sl.id=p.belief_slot_id
    WHERE p.owner_scope_id=owner AND p.id=ANY(proposition_ids)
   UNION SELECT frame_instance_id FROM public.frame_instance_roles WHERE owner_scope_id=owner AND claim_id=ANY(claim_ids)
   UNION SELECT source_frame_instance_id FROM public.resolution_assertions WHERE owner_scope_id=owner AND id=ANY(resolution_ids)
   UNION SELECT target_frame_instance_id FROM public.resolution_assertions
    WHERE owner_scope_id=owner AND id=ANY(resolution_ids) AND target_frame_instance_id IS NOT NULL) AS frames;

 DELETE FROM public.open_commitments_projection WHERE owner_scope_id=owner AND commitment_frame_instance_id=ANY(frame_ids);
 GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('projectionRows', n);
 DELETE FROM public.obligations_projection WHERE owner_scope_id=owner AND obligation_frame_instance_id=ANY(frame_ids);
 GET DIAGNOSTICS n = ROW_COUNT; counts := jsonb_set(counts,'{projectionRows}',to_jsonb((counts->>'projectionRows')::int+n));
 DELETE FROM public.schedule_projection WHERE owner_scope_id=owner AND (scheduled_frame_instance_id=ANY(frame_ids)
  OR outcome_resolution_id=ANY(resolution_ids) OR realization_link_id=ANY(link_ids));
 GET DIAGNOSTICS n = ROW_COUNT; counts := jsonb_set(counts,'{projectionRows}',to_jsonb((counts->>'projectionRows')::int+n));

 DELETE FROM public.memory_embeddings WHERE owner_scope_id=owner
  AND (object_id=ANY(claim_ids) OR proposition_id=ANY(proposition_ids) OR source_item_ids && ARRAY[evidence]);
 GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('embeddings', n);
 DELETE FROM public.memory_thread_members WHERE owner_scope_id=owner
  AND ((object_type='claim' AND object_id=ANY(claim_ids)) OR (object_type='proposition' AND object_id=ANY(proposition_ids))
   OR (object_type='resolution_assertion' AND object_id=ANY(resolution_ids)));
 GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('threadMemberships', n);
 DELETE FROM public.resolution_assertions WHERE owner_scope_id=owner AND id=ANY(resolution_ids);
 GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('resolutionAssertions', n);
 DELETE FROM public.memory_links WHERE owner_scope_id=owner AND id=ANY(link_ids);
 GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('links', n);
 DELETE FROM public.belief_support WHERE owner_scope_id=owner
  AND (claim_id=ANY(claim_ids) OR proposition_id=ANY(proposition_ids) OR supporting_proposition_id=ANY(proposition_ids));
 GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('supportRows', n);
 DELETE FROM public.claim_relations WHERE owner_scope_id=owner
  AND (from_claim_id=ANY(claim_ids) OR to_claim_id=ANY(claim_ids));
 DELETE FROM public.frame_instance_roles WHERE owner_scope_id=owner AND claim_id=ANY(claim_ids);
 DELETE FROM public.instance_match_candidates WHERE owner_scope_id=owner
  AND (claim_id=ANY(claim_ids) OR extraction_run_id=ANY(run_ids));
 DELETE FROM public.derived_proposition_dependencies WHERE owner_scope_id=owner AND derived_proposition_id=ANY(proposition_ids);
 DELETE FROM public.belief_assessments WHERE owner_scope_id=owner AND proposition_id=ANY(proposition_ids);
 GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('beliefAssessments', n);
 DELETE FROM public.proposition_fingerprints WHERE owner_scope_id=owner AND proposition_id=ANY(proposition_ids);
 DELETE FROM public.proposition_lineage WHERE owner_scope_id=owner
  AND (from_proposition_id=ANY(proposition_ids) OR to_proposition_id=ANY(proposition_ids));
 DELETE FROM public.claims WHERE owner_scope_id=owner AND id=ANY(claim_ids);
 GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('claims', n);
 DELETE FROM public.propositions WHERE owner_scope_id=owner AND id=ANY(proposition_ids);
 GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('unsupportedBeliefs', n);
 DELETE FROM public.model_call_records WHERE owner_scope_id=owner AND extraction_run_id=ANY(run_ids);
 DELETE FROM public.extraction_runs WHERE owner_scope_id=owner AND id=ANY(run_ids);
 GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('extractionRuns', n);
 DELETE FROM public.triage_decisions WHERE owner_scope_id=owner AND source_item_id=evidence;
 GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('parsedContent', n);
 DELETE FROM public.source_anchors WHERE owner_scope_id=owner AND id=ANY(anchor_ids);
 GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('anchors', n);
 DELETE FROM public.evidence_ingestion_receipts WHERE owner_scope_id=owner AND source_item_id=evidence;
 DELETE FROM public.entity_aliases WHERE owner_scope_id=owner AND source_item_id=evidence;
 GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('aliases', n);

 erased_ids := ARRAY[evidence] || anchor_ids || claim_ids || proposition_ids || resolution_ids;
 DELETE FROM public.memory_summaries WHERE owner_scope_id=owner AND source_object_ids && erased_ids;
 GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('summaries', n);

 UPDATE public.owner_overlay_deltas SET raw_text='[erased]'
  WHERE owner_scope_id=owner AND source_evidence_id=evidence AND raw_text<>'[erased]';
 GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('overlayTextsErased', n);
 UPDATE public.belief_transaction_operations o SET payload='{"erased":true}'::jsonb
  WHERE o.owner_scope_id=owner AND o.payload<>'{"erased":true}'::jsonb
   AND (EXISTS(SELECT 1 FROM public.belief_transactions t WHERE t.owner_scope_id=owner
      AND t.id=o.belief_transaction_id AND evidence=ANY(t.source_evidence_ids))
    OR EXISTS(SELECT 1 FROM unnest(erased_ids) AS i(id)
      WHERE strpos(o.payload::text, i.id::text)>0 OR strpos(coalesce(o.result_object_refs::text,''), i.id::text)>0));
 GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('transactionPayloadsErased', n);
 UPDATE public.context_packets p SET packet='{"erased":true}'::jsonb, request='{"erased":true}'::jsonb
  WHERE p.owner_scope_id=owner AND p.packet<>'{"erased":true}'::jsonb
   AND EXISTS(SELECT 1 FROM unnest(erased_ids) AS i(id) WHERE strpos(p.packet::text, i.id::text)>0);
 GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('contextPacketsErased', n);

 -- Records composed from memory that name a removed object: the whole row is
 -- searched as text, so an id held in a manifest, a fact list or a supporting
 -- episode counts as well as one in a column.
 named_ids := ARRAY(SELECT unnest(erased_ids || frame_ids)::text);
 SELECT coalesce(array_agg(e.id),'{}') INTO edition_ids FROM public.briefing_editions e
  WHERE e.owner_scope_id=owner AND (EXISTS(SELECT 1 FROM unnest(named_ids) AS i(id) WHERE strpos(to_jsonb(e)::text, i.id)>0)
   OR EXISTS(SELECT 1 FROM public.briefing_items b WHERE b.owner_scope_id=owner AND b.briefing_edition_id=e.id
    AND EXISTS(SELECT 1 FROM unnest(named_ids) AS i(id) WHERE strpos(to_jsonb(b)::text, i.id)>0)));
 DELETE FROM public.briefing_items WHERE owner_scope_id=owner AND briefing_edition_id=ANY(edition_ids);
 GET DIAGNOSTICS n = ROW_COUNT; derived := derived+n;
 DELETE FROM public.briefing_editions WHERE owner_scope_id=owner AND id=ANY(edition_ids);
 GET DIAGNOSTICS n = ROW_COUNT; derived := derived+n;
 SELECT coalesce(array_agg(c.id),'{}') INTO card_ids FROM public.clarification_cards c
  WHERE c.owner_scope_id=owner AND (c.reopened_by_evidence_id=evidence
   OR EXISTS(SELECT 1 FROM unnest(named_ids) AS i(id) WHERE strpos(to_jsonb(c)::text, i.id)>0));
 DELETE FROM public.interruption_decisions WHERE owner_scope_id=owner AND clarification_card_id=ANY(card_ids);
 GET DIAGNOSTICS n = ROW_COUNT; derived := derived+n;
 DELETE FROM public.clarification_cards WHERE owner_scope_id=owner AND id=ANY(card_ids);
 GET DIAGNOSTICS n = ROW_COUNT; derived := derived+n;
 DELETE FROM public.weekly_reviews w WHERE w.owner_scope_id=owner
  AND EXISTS(SELECT 1 FROM unnest(named_ids) AS i(id) WHERE strpos(to_jsonb(w)::text, i.id)>0);
 GET DIAGNOSTICS n = ROW_COUNT; derived := derived+n;
 DELETE FROM public.behavioral_observations o WHERE o.owner_scope_id=owner
  AND EXISTS(SELECT 1 FROM unnest(named_ids) AS i(id) WHERE strpos(to_jsonb(o)::text, i.id)>0);
 GET DIAGNOSTICS n = ROW_COUNT; derived := derived+n;
 counts := counts || jsonb_build_object('derivedRecords', derived);

 UPDATE public.source_items SET deleted_at=clock_timestamp(), external_id='erased:'||id::text,
   idempotency_key='erased:'||id::text, content_hash=encode(sha256(convert_to('erased:'||id::text,'UTF8')),'hex'),
   parent_external_id=NULL, occurred_at=NULL, actor_ref='{}'::jsonb, deterministic_metadata='{}'::jsonb
  WHERE owner_scope_id=owner AND id=evidence;
 UPDATE public.evidence_object_keys SET deleted_at=clock_timestamp()
  WHERE owner_scope_id=owner AND source_item_id=evidence AND deleted_at IS NULL;

 RETURN jsonb_build_object('evidenceId', evidence, 'rawObjectRef', raw_ref, 'counts', counts,
  'claimIds', to_jsonb(claim_ids), 'propositionIds', to_jsonb(proposition_ids),
  'resolutionAssertionIds', to_jsonb(resolution_ids), 'frameInstanceIds', to_jsonb(frame_ids));
END
$$;
REVOKE ALL ON FUNCTION unai_private.erase_evidence(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION unai_private.erase_evidence(uuid,uuid) TO unai_app;

-- Derived-data retention (design `PATCH /v1/settings/retention`): past the
-- owner's derived retention for a source type, the regenerable derivatives of
-- that source type's evidence -- its semantic index entries and the summaries
-- naming it -- expire, while the raw evidence and the canonical beliefs it
-- supports stay until raw retention or the owner removes them.
CREATE FUNCTION unai_private.expire_derived_data(owner uuid, source text, cutoff timestamptz) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE expired uuid[]; embeddings integer; summaries integer;
BEGIN
 IF NOT unai_private.has_owner_access(owner) OR current_setting('unai.purpose',true) IS DISTINCT FROM 'data.delete' THEN
  RAISE EXCEPTION 'ERASURE_NOT_AUTHORIZED' USING ERRCODE='42501';
 END IF;
 SELECT coalesce(array_agg(id),'{}') INTO expired FROM public.source_items
  WHERE owner_scope_id=owner AND source_type=source AND deleted_at IS NULL AND observed_at<cutoff;
 DELETE FROM public.memory_embeddings WHERE owner_scope_id=owner AND source_item_ids && expired;
 GET DIAGNOSTICS embeddings = ROW_COUNT;
 DELETE FROM public.memory_summaries WHERE owner_scope_id=owner AND source_object_ids && expired;
 GET DIAGNOSTICS summaries = ROW_COUNT;
 RETURN jsonb_build_object('evidenceItems', cardinality(expired), 'embeddings', embeddings, 'summaries', summaries);
END
$$;
REVOKE ALL ON FUNCTION unai_private.expire_derived_data(uuid,text,timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION unai_private.expire_derived_data(uuid,text,timestamptz) TO unai_app;

-- The semantic index is regenerable (PRD §33.13): the owner may drop it and
-- rebuild it from canonical memory (CRT-NFR-04-A). A definer for the same reason
-- as the erasure: `memory_embeddings` stays undeletable by the application role.
CREATE FUNCTION unai_private.drop_semantic_index(owner uuid) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE n integer;
BEGIN
 IF NOT unai_private.has_owner_access(owner) OR current_setting('unai.purpose',true) IS DISTINCT FROM 'memory.reindex' THEN
  RAISE EXCEPTION 'REINDEX_NOT_AUTHORIZED' USING ERRCODE='42501';
 END IF;
 DELETE FROM public.memory_embeddings WHERE owner_scope_id=owner;
 GET DIAGNOSTICS n = ROW_COUNT;
 RETURN n;
END
$$;
REVOKE ALL ON FUNCTION unai_private.drop_semantic_index(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION unai_private.drop_semantic_index(uuid) TO unai_app;

-- ---------------------------------------------------------------------------
-- The immutability triggers admit exactly the erasure, under `data.delete`, and
-- nothing else. Each branch compares the whole row except the erased columns,
-- so an erasure cannot carry any other change with it.
CREATE OR REPLACE FUNCTION unai_private.immutable_evidence() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
 BEGIN
  IF current_setting('unai.purpose',true)='data.delete' THEN
   IF TG_TABLE_NAME='source_items' THEN
    -- The tombstone: no content, no metadata, no actor, and an external id,
    -- idempotency key and content hash derived from the row id alone, so the
    -- same content ingested again is a new item rather than a hit on this row.
    IF OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL
     AND NEW.external_id='erased:'||OLD.id::text AND NEW.idempotency_key='erased:'||OLD.id::text
     AND NEW.content_hash=encode(sha256(convert_to('erased:'||OLD.id::text,'UTF8')),'hex')
     AND NEW.parent_external_id IS NULL AND NEW.occurred_at IS NULL
     AND NEW.actor_ref='{}'::jsonb AND NEW.deterministic_metadata='{}'::jsonb
     AND (to_jsonb(NEW)-ARRAY['deleted_at','external_id','idempotency_key','content_hash','parent_external_id',
       'occurred_at','actor_ref','deterministic_metadata'])
      =(to_jsonb(OLD)-ARRAY['deleted_at','external_id','idempotency_key','content_hash','parent_external_id',
       'occurred_at','actor_ref','deterministic_metadata']) THEN
     RETURN NEW;
    END IF;
   ELSIF TG_TABLE_NAME='evidence_object_keys' THEN
    IF OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL
     AND (to_jsonb(NEW)-'deleted_at')=(to_jsonb(OLD)-'deleted_at') THEN
     RETURN NEW;
    END IF;
   END IF;
  END IF;
  RAISE EXCEPTION 'EVIDENCE_IMMUTABLE' USING ERRCODE='55000';
 END
$$;

CREATE OR REPLACE FUNCTION unai_private.overlay_delta_transition() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 -- The owner's words are erased with the evidence they were stored as; the
 -- delta, its sequence and its lifecycle stay, because they are the owner's
 -- history of what they did, not the content they deleted.
 IF current_setting('unai.purpose',true)='data.delete' AND NEW.raw_text='[erased]'
  AND (to_jsonb(NEW)-'raw_text')=(to_jsonb(OLD)-'raw_text') THEN
  RETURN NEW;
 END IF;
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
END
$$;

CREATE OR REPLACE FUNCTION unai_private.belief_operation_result_only() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF current_setting('unai.purpose',true)='data.delete' AND NEW.payload='{"erased":true}'::jsonb
  AND (to_jsonb(NEW)-'payload')=(to_jsonb(OLD)-'payload') THEN
  RETURN NEW;
 END IF;
 IF NEW.id<>OLD.id OR NEW.owner_scope_id<>OLD.owner_scope_id OR NEW.belief_transaction_id<>OLD.belief_transaction_id
  OR NEW.operation_order<>OLD.operation_order OR NEW.operation_kind<>OLD.operation_kind OR NEW.payload<>OLD.payload THEN
  RAISE EXCEPTION 'BELIEF_OPERATION_IMMUTABLE' USING ERRCODE='55000';
 END IF;
 IF OLD.result_object_refs IS NOT NULL AND NEW.result_object_refs IS DISTINCT FROM OLD.result_object_refs THEN
  RAISE EXCEPTION 'BELIEF_OPERATION_RESULT_IMMUTABLE' USING ERRCODE='55000';
 END IF;
 RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION unai_private.canonicalization_record_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 -- A stored packet that carried a deleted object keeps its identity and hash,
 -- so the manifests that name it still resolve, and loses its content.
 -- Nested, because the function serves many tables and only this one has a
 -- `packet` column: plpgsql does not short-circuit a field reference.
 IF TG_TABLE_NAME='context_packets' AND current_setting('unai.purpose',true)='data.delete' THEN
  IF NEW.packet='{"erased":true}'::jsonb AND NEW.request='{"erased":true}'::jsonb
   AND (to_jsonb(NEW)-'packet'-'request')=(to_jsonb(OLD)-'packet'-'request') THEN
   RETURN NEW;
  END IF;
 END IF;
 RAISE EXCEPTION 'CANONICALIZATION_RECORD_IMMUTABLE' USING ERRCODE='55000';
END
$$;
