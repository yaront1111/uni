-- ADR 0046: owner policies check membership once per statement.
--
-- has_owner_access(<owner column>) is SECURITY DEFINER with a SET clause, so PostgreSQL never inlines it: a policy
-- runs one membership lookup per candidate row, and under a one-row owner estimate the planner's nested loops
-- rescan the owner's rows, so the lookups grow with the square of the rows (task-be2a16f3).
-- authorized_owner_id() takes no argument, so `<owner column> = (SELECT unai_private.authorized_owner_id())` is an
-- uncorrelated subquery the planner makes an InitPlan: one lookup per statement and owner-table reference.
-- It returns owner_id() when the actor holds a live membership of that owner, else NULL; NULL fails a USING or
-- WITH CHECK clause exactly as the old FALSE did, as long as the comparison stays a positive conjunct
-- (packages/postgres/src/owner-policies.test.ts enforces that).
--
-- CREATE OR REPLACE is deliberate: packages/capabilities/src/projection-replay.test.ts deletes the ledger from 0016
-- on and re-applies the files, while the pre-0016 tables keep policies that already call this function.
-- The inventory is read from pg_policies, not listed here: 0024 creates policies in EXECUTE format loops and later
-- migrations dropped 77 policies, so the source shows 339 call sites where the live 238 policies hold 279.
-- has_owner_access stays defined and granted for the definer helpers that call it with a scalar owner.

CREATE OR REPLACE FUNCTION unai_private.authorized_owner_id() RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT m.owner_scope_id FROM public.owner_scope_members m
  JOIN public.users u ON u.id=m.user_id
  JOIN public.owner_scopes o ON o.id=m.owner_scope_id
  WHERE m.owner_scope_id=unai_private.owner_id() AND m.user_id=unai_private.actor_id()
    AND m.valid_from<=statement_timestamp()
    AND (m.valid_to IS NULL OR m.valid_to>statement_timestamp())
    AND u.disabled_at IS NULL AND o.deleted_at IS NULL
$$;
REVOKE ALL ON FUNCTION unai_private.authorized_owner_id() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION unai_private.authorized_owner_id() TO unai_app;

-- ALTER POLICY in place keeps each policy's name, command, roles and permissive or restrictive mode, and re-records
-- its pg_depend rows. Only a clause that contains the call is named: an INSERT policy has no USING, a SELECT or
-- DELETE policy has no WITH CHECK, and an ALL or UPDATE policy with no WITH CHECK keeps reusing its USING.
-- With search_path pinned to pg_catalog, pg_get_expr prints every other name schema-qualified, so the text
-- re-parses to the same objects.
DO $$
DECLARE
  saved_path text := current_setting('search_path');
  pol record;
  ddl text;
  rewritten text;
  found_calls integer := 0;
  written_calls integer := 0;
BEGIN
  PERFORM set_config('search_path', 'pg_catalog', true);
  FOR pol IN
    SELECT schemaname, tablename, policyname, qual, with_check FROM pg_policies
    WHERE qual ~ 'has_owner_access' OR with_check ~ 'has_owner_access'
    ORDER BY schemaname, tablename, policyname
  LOOP
    ddl := format('ALTER POLICY %I ON %I.%I', pol.policyname, pol.schemaname, pol.tablename);
    IF pol.qual ~ 'has_owner_access' THEN
      rewritten := regexp_replace(pol.qual, 'unai_private\.has_owner_access\(([^()]*)\)',
        '(\1 = (SELECT unai_private.authorized_owner_id()))', 'g');
      found_calls := found_calls + regexp_count(pol.qual, 'has_owner_access\(');
      written_calls := written_calls + regexp_count(rewritten, 'authorized_owner_id\(\)')
        - regexp_count(pol.qual, 'authorized_owner_id\(\)');
      ddl := ddl || ' USING (' || rewritten || ')';
    END IF;
    IF pol.with_check ~ 'has_owner_access' THEN
      rewritten := regexp_replace(pol.with_check, 'unai_private\.has_owner_access\(([^()]*)\)',
        '(\1 = (SELECT unai_private.authorized_owner_id()))', 'g');
      found_calls := found_calls + regexp_count(pol.with_check, 'has_owner_access\(');
      written_calls := written_calls + regexp_count(rewritten, 'authorized_owner_id\(\)')
        - regexp_count(pol.with_check, 'authorized_owner_id\(\)');
      ddl := ddl || ' WITH CHECK (' || rewritten || ')';
    END IF;
    EXECUTE ddl;
  END LOOP;
  IF found_calls = 0 OR found_calls <> written_calls
    OR EXISTS (SELECT 1 FROM pg_policies WHERE qual ~ 'has_owner_access' OR with_check ~ 'has_owner_access')
    OR EXISTS (SELECT 1 FROM pg_depend WHERE classid = 'pg_policy'::regclass AND refclassid = 'pg_proc'::regclass
      AND refobjid = 'unai_private.has_owner_access(uuid)'::regprocedure) THEN
    RAISE EXCEPTION 'OWNER_POLICY_REWRITE_INCOMPLETE';
  END IF;
  PERFORM set_config('search_path', saved_path, true);
END $$;
