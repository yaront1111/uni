-- ADR 0013 (amended 2026-11-07): a connector credential handle names a path,
-- `secret://<provider>/connectors/<ownerScopeId>/<label>[#<field>]`. Migration
-- 0018's secret_ref CHECK admitted no `/`, so POST /v1/connectors answered 500
-- for such a handle.
-- The replacement accepts every value the 0018 CHECK accepted (ADD CONSTRAINT
-- re-validates existing rows) and every handle @unai/secrets parses: a name of up
-- to 256 characters in `/`-separated segments, and a field of up to 64. It still
-- refuses an empty, `.` or `..` segment, a leading or trailing `/`, and
-- whitespace. A PostgreSQL regex bound stops at 255, so the name length is the
-- separate char_length clause.
-- It binds no owner: a later migration's trigger does (ADR 0013, layer 2).
-- The CHECK is dropped by name without IF EXISTS, as 0047 does, so a different
-- name fails loudly; the name is kept for projection replay and the logs.
ALTER TABLE connectors DROP CONSTRAINT connectors_secret_ref_check;
ALTER TABLE connectors ADD CONSTRAINT connectors_secret_ref_check CHECK(secret_ref IS NULL OR (
 secret_ref ~ '^secret://[a-z0-9][a-z0-9_.-]{0,62}/[A-Za-z0-9][A-Za-z0-9_.:-]*(/([A-Za-z0-9_:-][A-Za-z0-9_.:-]*|\.[A-Za-z0-9_:-][A-Za-z0-9_.:-]*|\.\.[A-Za-z0-9_.:-]+))*(#[A-Za-z0-9][A-Za-z0-9_.-]{0,63})?$'
 AND char_length(substring(secret_ref FROM '^secret://[^/]*/([^#]*)'))<=256));
