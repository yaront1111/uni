-- ADR 0041 D5: admit the Omi transcript anchor kind and the OMI connector type.
-- Both enum CHECKs are replaced under their existing names, so readers of
-- pg_constraint or error.constraint see no change. There is deliberately no
-- IF EXISTS: a wrong constraint name must fail the migration, never silently
-- leave the old CHECK in place. 0004's length check is a different constraint
-- and stays untouched.
ALTER TABLE source_anchors DROP CONSTRAINT source_anchors_kind,
 ADD CONSTRAINT source_anchors_kind
 CHECK(anchor_kind IN ('MESSAGE_SPAN','DOCUMENT_RANGE','CALENDAR_FIELD','CONNECTOR_JSON_PATH','GITHUB_COMMENT','TRANSCRIPT_SEGMENT'));
ALTER TABLE domain_sensitivity_settings DROP CONSTRAINT domain_sensitivity_settings_source_type_check,
 ADD CONSTRAINT domain_sensitivity_settings_source_type_check
 CHECK(source_type IN ('CONVERSATION','GMAIL','GOOGLE_CALENDAR','GITHUB','DOCUMENT','OMI'));
