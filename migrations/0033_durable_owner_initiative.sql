-- ADR 0039: explicit owner watches, durable local recurrence, and content-free receipts.
CREATE TABLE initiative_settings (
 owner_scope_id uuid PRIMARY KEY REFERENCES owner_scopes(id),
 actor_id uuid NOT NULL,
 enabled boolean NOT NULL DEFAULT false,
 time_zone text NOT NULL CHECK(length(time_zone) BETWEEN 1 AND 64),
 local_time text NOT NULL CHECK(local_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
 data_purpose text NOT NULL CHECK(data_purpose ~ '^[A-Z][A-Z0-9_]{0,63}$'),
 maximum_sensitivity text NOT NULL CHECK(maximum_sensitivity IN ('NORMAL','PRIVATE','RESTRICTED')),
 prepare_drafts boolean NOT NULL DEFAULT false,
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 next_due_at timestamptz,
 last_input_marker text,
 updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(owner_scope_id,actor_id) REFERENCES owner_scope_members(owner_scope_id,user_id)
);
ALTER TABLE initiative_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE initiative_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_read ON initiative_settings FOR SELECT TO unai_app USING(unai_private.has_owner_access(owner_scope_id));
CREATE POLICY owner_configure ON initiative_settings FOR INSERT TO unai_app WITH CHECK(unai_private.has_owner_access(owner_scope_id)
 AND actor_id=unai_private.actor_id() AND current_setting('unai.purpose',true)='settings.attention');
CREATE POLICY owner_drive ON initiative_settings FOR UPDATE TO unai_app USING(unai_private.has_owner_access(owner_scope_id)
 AND current_setting('unai.purpose',true) IN ('settings.attention','jobs.enqueue')) WITH CHECK(unai_private.has_owner_access(owner_scope_id));
GRANT SELECT,INSERT,UPDATE ON initiative_settings TO unai_app;

CREATE TABLE initiative_watches (
 id uuid PRIMARY KEY,
 owner_scope_id uuid NOT NULL REFERENCES owner_scopes(id),
 source_item_id uuid NOT NULL,
 source_anchor_id uuid NOT NULL,
 scheduled_frame_id uuid NOT NULL,
 prerequisite_frame_id uuid NOT NULL,
 enabled boolean NOT NULL DEFAULT true,
 snoozed_until timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(owner_scope_id,id),UNIQUE(owner_scope_id,source_item_id),
 CHECK(scheduled_frame_id<>prerequisite_frame_id),
 FOREIGN KEY(owner_scope_id,source_item_id) REFERENCES source_items(owner_scope_id,id),
 FOREIGN KEY(owner_scope_id,source_anchor_id) REFERENCES source_anchors(owner_scope_id,id) ON DELETE CASCADE,
 FOREIGN KEY(owner_scope_id,scheduled_frame_id) REFERENCES frame_instances(owner_scope_id,id) ON DELETE CASCADE,
 FOREIGN KEY(owner_scope_id,prerequisite_frame_id) REFERENCES frame_instances(owner_scope_id,id) ON DELETE CASCADE
);
ALTER TABLE initiative_watches ENABLE ROW LEVEL SECURITY;
ALTER TABLE initiative_watches FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_read ON initiative_watches FOR SELECT TO unai_app USING(unai_private.has_owner_access(owner_scope_id)
 AND (current_setting('unai.purpose',true) IN ('action.draft','memory.inbox') OR EXISTS(SELECT 1 FROM source_items s WHERE s.owner_scope_id=initiative_watches.owner_scope_id AND s.id=source_item_id)));
CREATE POLICY owner_append ON initiative_watches FOR INSERT TO unai_app WITH CHECK(unai_private.has_owner_access(owner_scope_id)
 AND current_setting('unai.purpose',true)='memory.correct' AND EXISTS(SELECT 1 FROM source_items s WHERE s.owner_scope_id=initiative_watches.owner_scope_id AND s.id=source_item_id));
CREATE POLICY owner_change ON initiative_watches FOR UPDATE TO unai_app USING(unai_private.has_owner_access(owner_scope_id)
 AND current_setting('unai.purpose',true)='memory.correct') WITH CHECK(unai_private.has_owner_access(owner_scope_id));
GRANT SELECT,INSERT ON initiative_watches TO unai_app;
GRANT UPDATE(enabled,snoozed_until) ON initiative_watches TO unai_app;

CREATE TABLE initiative_receipts (
 id uuid PRIMARY KEY,
 owner_scope_id uuid NOT NULL REFERENCES owner_scopes(id),
 watch_id uuid NOT NULL,
 state_digest text NOT NULL CHECK(state_digest ~ '^[a-f0-9]{64}$'),
 threshold text NOT NULL CHECK(threshold IN ('UPCOMING','IMMINENT','OVERDUE')),
 owner_local_date date NOT NULL,
 source_evidence_ids uuid[] NOT NULL CHECK(cardinality(source_evidence_ids)>0),
 packet_id uuid NOT NULL,
 attention_decision text NOT NULL CHECK(attention_decision IN ('ASK','BATCH','SUPPRESS')),
 attention_reason text NOT NULL,
 attention_inputs jsonb NOT NULL,
 preparation text NOT NULL CHECK(preparation IN ('NOT_REQUESTED','CAPABILITY_NOT_GRANTED','CONFIRMATION_REQUIRED','POLICY_DENIED','DRAFTED')),
 draft_id uuid,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(owner_scope_id,id),UNIQUE(owner_scope_id,watch_id,state_digest,threshold,owner_local_date),
 FOREIGN KEY(owner_scope_id,watch_id) REFERENCES initiative_watches(owner_scope_id,id) ON DELETE CASCADE,
 FOREIGN KEY(owner_scope_id,packet_id) REFERENCES context_packets(owner_scope_id,id) ON DELETE CASCADE,
 FOREIGN KEY(owner_scope_id,draft_id) REFERENCES drafts(owner_scope_id,id)
);
ALTER TABLE initiative_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE initiative_receipts FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_read ON initiative_receipts FOR SELECT TO unai_app USING(unai_private.has_owner_access(owner_scope_id)
 AND (current_setting('unai.purpose',true) IN ('memory.inbox','action.draft') OR NOT EXISTS(
  SELECT 1 FROM unnest(source_evidence_ids) e(id) LEFT JOIN source_items s ON s.owner_scope_id=initiative_receipts.owner_scope_id AND s.id=e.id WHERE e.id IS NULL OR s.id IS NULL)));
CREATE POLICY owner_append ON initiative_receipts FOR INSERT TO unai_app WITH CHECK(unai_private.has_owner_access(owner_scope_id)
 AND current_setting('unai.purpose',true) IN ('memory.inbox','action.draft'));
GRANT SELECT,INSERT ON initiative_receipts TO unai_app;
