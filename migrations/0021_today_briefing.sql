-- The Today briefing: one edition per briefing read and the items it ranked
-- (design entities `briefing_editions` and `briefing_items`; PRD §7.1, §24.5,
-- §26; ADR 0026 records the decisions below before the code).
--
-- Four rules are carried by the schema rather than by convention:
--
--  1. An edition is built from one persisted Context Broker packet. It names that
--     packet by a composite owner foreign key and carries the manifest of what the
--     packet supplied, so a briefing can always be traced back to the context it
--     was built from (CRT-UX-01-A).
--  2. An edition is a record of what was shown on one owner-local date in one
--     timezone. Neither table can be updated or deleted, because the edition
--     history is what suppresses an unchanged low-priority repeat the next day
--     (CRT-UX-01-B); a rewritable history could suppress anything.
--  3. The briefing is written under `memory.read`, the same read purpose that
--     writes the packet it rests on. Like `context_packets`, these rows are a
--     record of a read, not canonical memory: no canonical table gains a policy.
--  4. Every item carries the seven rank components it was ordered by, and none of
--     them is a timestamp: the order is never "newest first" (CRT-UX-02-A).

CREATE TABLE briefing_editions (
 id uuid PRIMARY KEY,
 owner_scope_id uuid NOT NULL REFERENCES owner_scopes(id),
 requesting_actor_id uuid NOT NULL,
 -- The owner's calendar date in `timezone` at `generated_at`, never the UTC date.
 owner_local_date date NOT NULL,
 timezone text NOT NULL CHECK(timezone ~ '^[A-Za-z][A-Za-z0-9_+/-]{0,63}$'),
 utc_offset text NOT NULL CHECK(utc_offset ~ '^[+-][0-9]{2}:[0-9]{2}$'),
 generated_at timestamptz NOT NULL,
 context_packet_id uuid NOT NULL,
 packet_hash text NOT NULL CHECK(packet_hash ~ '^[a-f0-9]{64}$'),
 -- What the packet supplied: beliefs, evidence, overlay deltas, resolutions,
 -- projection versions and watermarks. Derived from the persisted packet.
 packet_manifest jsonb NOT NULL CHECK(jsonb_typeof(packet_manifest)='object'),
 -- At most a few, each labelled RECOMMENDED and never stored as the owner's
 -- intent or as something done.
 recommendations jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(recommendations)='array'
  AND jsonb_array_length(recommendations)<=3),
 withheld_recommendations jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(withheld_recommendations)='array'),
 projection_completeness jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(projection_completeness)='array'),
 ranking_version text NOT NULL CHECK(ranking_version ~ '^[a-z][a-z0-9_.-]{0,63}$'),
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(owner_scope_id,id),
 FOREIGN KEY(owner_scope_id,requesting_actor_id) REFERENCES owner_scope_members(owner_scope_id,user_id),
 FOREIGN KEY(owner_scope_id,context_packet_id) REFERENCES context_packets(owner_scope_id,id)
);
CREATE INDEX briefing_editions_owner_date ON briefing_editions(owner_scope_id,owner_local_date DESC,created_at DESC);

CREATE TABLE briefing_items (
 id uuid PRIMARY KEY,
 owner_scope_id uuid NOT NULL REFERENCES owner_scopes(id),
 briefing_edition_id uuid NOT NULL,
 item_object_type text NOT NULL CHECK(item_object_type IN ('frame_instance','owner_overlay_delta')),
 item_object_id uuid NOT NULL,
 domain_section text NOT NULL CHECK(domain_section IN ('WORK','PERSONAL','FINANCE')),
 headline text NOT NULL CHECK(length(headline) BETWEEN 1 AND 1000),
 why_surfaced text NOT NULL CHECK(length(why_surfaced) BETWEEN 1 AND 1000),
 -- consequence, urgency, goal relevance, confidence, effort, reversibility and
 -- attention budget, each in [0,1]. No component is a time of recording.
 rank_components jsonb NOT NULL CHECK(jsonb_typeof(rank_components)='object'
  AND rank_components ?& ARRAY['consequence','urgency','goalRelevance','confidence','effort','reversibility','attentionBudget']),
 rank_score numeric NOT NULL CHECK(rank_score >= 0 AND rank_score <= 1),
 priority text NOT NULL CHECK(priority IN ('HIGH','NORMAL','LOW')),
 certainty_label text NOT NULL CHECK(certainty_label IN ('CONFIRMED','REPORTED','INFERRED','CONTESTED',
  'PENDING_OWNER_ASSERTION','SCHEDULED','RESOLVED','UNKNOWN','INTENDED','COMMITTED','PREDICTED','RECOMMENDED')),
 target_time timestamptz,
 past_target boolean NOT NULL,
 outcome_state text NOT NULL CHECK(outcome_state IN ('UNRESOLVED','PARTIALLY_RESOLVED','RESOLVED','CONTESTED','PENDING')),
 -- The material state the item was shown in. An unchanged fingerprint on a later
 -- date is what "unchanged" means for repeat suppression.
 material_fingerprint text NOT NULL CHECK(material_fingerprint ~ '^[a-f0-9]{64}$'),
 source_refs jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(source_refs)='array'),
 suppressed_as_unchanged boolean NOT NULL DEFAULT false,
 deferred_by_attention_budget boolean NOT NULL DEFAULT false,
 -- The shown position, 1-based; null exactly when the item was not shown.
 rank_position integer CHECK(rank_position IS NULL OR rank_position >= 1),
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(owner_scope_id,id),
 UNIQUE(briefing_edition_id,item_object_type,item_object_id),
 FOREIGN KEY(owner_scope_id,briefing_edition_id) REFERENCES briefing_editions(owner_scope_id,id),
 CONSTRAINT briefing_items_one_reason_hidden CHECK(NOT (suppressed_as_unchanged AND deferred_by_attention_budget)),
 CONSTRAINT briefing_items_position_when_shown CHECK((rank_position IS NULL) = (suppressed_as_unchanged OR deferred_by_attention_budget))
);
CREATE INDEX briefing_items_object ON briefing_items(owner_scope_id,item_object_type,item_object_id);

ALTER TABLE briefing_editions ENABLE ROW LEVEL SECURITY;
ALTER TABLE briefing_editions FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_read ON briefing_editions FOR SELECT TO unai_app
 USING(unai_private.has_owner_access(owner_scope_id) AND unai_private.memory_purpose(ARRAY['memory.read','memory.inspect']));
-- Written by the briefing read, for the session's own actor, over a packet the
-- same owner holds (the composite foreign key).
CREATE POLICY owner_record ON briefing_editions FOR INSERT TO unai_app
 WITH CHECK(unai_private.has_owner_access(owner_scope_id) AND unai_private.memory_purpose(ARRAY['memory.read'])
 AND requesting_actor_id=unai_private.actor_id());
GRANT SELECT,INSERT ON briefing_editions TO unai_app;

ALTER TABLE briefing_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE briefing_items FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_read ON briefing_items FOR SELECT TO unai_app
 USING(unai_private.has_owner_access(owner_scope_id) AND unai_private.memory_purpose(ARRAY['memory.read','memory.inspect']));
CREATE POLICY owner_record ON briefing_items FOR INSERT TO unai_app
 WITH CHECK(unai_private.has_owner_access(owner_scope_id) AND unai_private.memory_purpose(ARRAY['memory.read'])
 AND EXISTS(SELECT 1 FROM briefing_editions e WHERE e.owner_scope_id=briefing_items.owner_scope_id
   AND e.id=briefing_items.briefing_edition_id AND e.requesting_actor_id=unai_private.actor_id()));
GRANT SELECT,INSERT ON briefing_items TO unai_app;

-- An edition states what was shown on one date. Nothing about it is revised.
CREATE TRIGGER briefing_editions_immutable BEFORE UPDATE ON briefing_editions
 FOR EACH ROW EXECUTE FUNCTION unai_private.canonicalization_record_immutable();
CREATE TRIGGER briefing_items_immutable BEFORE UPDATE ON briefing_items
 FOR EACH ROW EXECUTE FUNCTION unai_private.canonicalization_record_immutable();
