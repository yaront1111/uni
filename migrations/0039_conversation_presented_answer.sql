-- Only post-validator output; old rows remain unknown. Inherits turn RLS/erasure.
ALTER TABLE conversation_turns ADD COLUMN presented_answer jsonb;
ALTER TABLE conversation_turns ADD CONSTRAINT presented_answer_assistant_only
 CHECK(presented_answer IS NULL OR (speaker='assistant' AND status='accepted'
   AND presented_answer->'grounding'->>'action' IN ('PASSED','DOWNGRADED','REGENERATED')));
