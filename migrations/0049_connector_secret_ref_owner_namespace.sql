-- ADR 0013 (amended 2026-11-07), layer 2: a connector's secret_ref may name only
-- `secret://<provider>/connectors/<owner_scope_id>/<label>[#<field>]` under the
-- @unai/secrets handle grammar, exactly as isConnectorCredentialHandle in
-- @unai/connectors decides, whichever role writes the row. Layer 1 is
-- createConnector's refusal; this binds every other writer too.
-- It is a trigger, not a CHECK, because it judges only a NEW value: an INSERT, or
-- an UPDATE that changes secret_ref. A legacy row outside the namespace keeps its
-- unrelated updates (status, cursor, last_sync_error), a re-set to the same value
-- and its disconnect or revocation to NULL (ADR 0013 legacy rule). Adding the
-- trigger re-validates no existing row.
-- BEFORE triggers run before CHECK constraints, so a malformed value gets this
-- code too. The error carries only the code: never the handle, the owner scope
-- or any other value.
CREATE FUNCTION unai_private.connector_secret_ref_namespace() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
 DECLARE
  owner_prefix text;
  handle_name text;
 BEGIN
  IF NEW.secret_ref IS NULL THEN
   RETURN NEW;
  END IF;
  IF TG_OP='UPDATE' THEN
   IF NEW.secret_ref IS NOT DISTINCT FROM OLD.secret_ref THEN
    RETURN NEW;
   END IF;
  END IF;
  owner_prefix := 'connectors/' || NEW.owner_scope_id::text || '/';
  handle_name := substring(NEW.secret_ref FROM '^secret://[a-z][a-z0-9]{0,31}/([A-Za-z0-9][A-Za-z0-9_./-]{0,255})(#[A-Za-z0-9][A-Za-z0-9_.-]{0,63})?$');
  IF handle_name IS NULL
   OR handle_name ~ '(^|/)\.{0,2}(/|$)'
   OR NOT starts_with(handle_name, owner_prefix)
   OR length(handle_name) <= length(owner_prefix) THEN
   RAISE EXCEPTION 'CONNECTOR_SECRET_REF_OUT_OF_SCOPE' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
 END
$$;
REVOKE ALL ON FUNCTION unai_private.connector_secret_ref_namespace() FROM PUBLIC;
CREATE TRIGGER connector_secret_ref_namespace BEFORE INSERT OR UPDATE OF secret_ref ON connectors
 FOR EACH ROW EXECUTE FUNCTION unai_private.connector_secret_ref_namespace();
