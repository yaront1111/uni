-- A document upload may name its DOCUMENT connector (PRD §20.5, CRT-CON-05-A).
-- uploadDocument proves that connector's `documents.upload` grant through
-- requireCapability, inside the same `evidence.ingest` transaction that stores
-- the document. Migration 0018's owner_read policy admits only connector.read,
-- connector.manage, connector.sync and memory.read, so under evidence.ingest the
-- granted row was invisible and every such upload was refused
-- CONNECTOR_CAPABILITY_NOT_GRANTED.
--
-- 0018 is applied and stays as it is. This adds a second permissive SELECT
-- policy, narrower than widening owner_read would be: under evidence.ingest an
-- owner sees only its own `documents.upload` rows, never another capability's
-- row, and gains no write path, because the INSERT and UPDATE policies stay
-- connector.manage only. The row keeps its granted and revoked state, so
-- requireCapability is still the one place that decides, and reading it in the
-- transaction that stores the document keeps the check and the insert atomic.
CREATE POLICY document_upload_read ON connector_capability_grants FOR SELECT TO unai_app
 USING(unai_private.has_owner_access(owner_scope_id)
 AND current_setting('unai.purpose',true)='evidence.ingest'
 AND capability_id='documents.upload');
