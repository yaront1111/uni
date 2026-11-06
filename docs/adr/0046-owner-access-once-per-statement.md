# ADR 0046: Owner policies check membership once per statement

Date: 2026-11-06

Status: Accepted. Changes the RLS policy shape of every owner-scoped table (the
owner isolation of ADR 0002); recorded before the code (PRD §0 rule 7).

## Context

Every owner policy starts with `unai_private.has_owner_access(<owner column>)`
(`migrations/0001_foundation.sql:70-82`). The function is
`LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog`, and
PostgreSQL never inlines a function that is `SECURITY DEFINER` or carries a
`SET` clause. A policy such as
`USING (unai_private.has_owner_access(owner_scope_id) AND ...)` therefore runs
one membership lookup (`owner_scope_members` joined to `users` and
`owner_scopes`) for every candidate row a scan produces.

That cost is linear only while the plan is. After an `ANALYZE`, a fresh owner
is estimated at `rows=1` (task-be2a16f3). The planner then picks nested loops
that rescan the owner's rows once per outer row, and every rescanned row
repeats the lookup, so the lookups grow with the square of the rows.
`packages/context/src/owner-statistics.test.ts` case (b) seeds 40 fresh frames
and bounds a statement at 534 membership evaluations. Measured before this
decision:

- `readableFrameCandidates` (`packages/context/src/candidates.ts`): 815;
- `proposition_slots` (`packages/context/src/support-authority.ts`): 731 to 774
  (runs differ);
- `independentVerification` (`packages/memory/src/overlay.ts:243`): 80 per call,
  and it runs 81 times in that test's context packet.

Owner decision (2026-11-06): fix the policy class once, not each statement.

The live inventory at migration 0044, read from `pg_policies`: 241 policies, all
`TO unai_app`. 238 of them call `has_owner_access` 279 times, 154 times in
`USING` and 125 times in `WITH CHECK`. Every call passes `owner_scope_id` except
`owner_scopes.owner_isolation`, which passes `id`. The migration source shows
339 call sites, because 0024 creates policies in `EXECUTE format` loops and
later migrations dropped 77 policies.

## Decision

1. The function. Migration 0045 adds
   `unai_private.authorized_owner_id() RETURNS uuid`.
   - It takes no argument and is
     `LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog`.
     EXECUTE is revoked from PUBLIC and granted only to `unai_app`.
   - Its body is `has_owner_access`'s membership check, selecting
     `m.owner_scope_id`: `owner_scope_members m` joined to `users u` and
     `owner_scopes o`, where `m.owner_scope_id=owner_id()`,
     `m.user_id=actor_id()`, `m.valid_from<=statement_timestamp()`,
     `m.valid_to IS NULL OR m.valid_to>statement_timestamp()`,
     `u.disabled_at IS NULL` and `o.deleted_at IS NULL`.
   - `(owner_scope_id,user_id)` is the primary key of `owner_scope_members`, so
     it returns `owner_id()` or NULL.
2. The shape. In `USING` and `WITH CHECK`,
   `<owner column> = (SELECT unai_private.authorized_owner_id())` replaces
   `unai_private.has_owner_access(<owner column>)`. `owner_scopes` compares
   `id`. Every other predicate is unchanged.
3. The rewrite. Migration 0045 reads the live set from `pg_policies`. A hand
   list would be wrong, because 0024 creates policies in loops and 77 policies
   were dropped later.
   - It uses `ALTER POLICY` in place, so each policy keeps its name, roles,
     command and permissive or restrictive mode, and nothing is dropped.
   - It pins `search_path` to `pg_catalog` while it reads. `pg_get_expr` then
     prints every non-catalog name schema-qualified, and the text re-parses to
     the same objects.
   - It names only the clauses that contain the call. An INSERT policy has no
     `USING` and a SELECT or DELETE policy has no `WITH CHECK`; a clause left
     out of `ALTER POLICY` is unchanged.
   - It fails with `OWNER_POLICY_REWRITE_INCOMPLETE` if it finds no call, if the
     calls found and the comparisons written differ in number, or if any policy
     still calls `has_owner_access`, by text or by `pg_depend`.
4. `has_owner_access` stays defined and granted. Fifteen call sites inside
   definer helpers run it once per call with a scalar owner:
   - 0017 `evidence_labels`;
   - 0019 `anchor_evidence_scope`;
   - 0024 `erase_evidence`, `expire_derived_data` and `drop_semantic_index`;
   - 0025 `economic_and_quality_inputs`;
   - 0029 `erase_evidence`;
   - 0030 `object_state_at`, `any_memory_object_removed` and
     `stored_outcomes_readable`;
   - 0031 `processing_release_version`;
   - 0032 `aging_policy`;
   - 0034 `active_goal_priorities`;
   - 0035 `proactive_attention_counts`;
   - 0036 `erase_conversation`.

   Several rely on its boolean false (`IF NOT ...`, `coalesce(...,false)`,
   `IS DISTINCT FROM true`, `CASE WHEN`). They are out of scope.
5. The guard. `packages/postgres/src/owner-policies.test.ts` reads
   `pg_policies` and fails on any policy that calls `has_owner_access`, calls
   `authorized_owner_id()` outside decision 2's comparison, or uses that
   comparison anywhere but as a positive conjunct. It also checks the
   function's attributes and grants, and compares it with `has_owner_access`
   case by case.

## Guarantees

- The same rows. `has_owner_access(X)` is TRUE exactly when `X = owner_id()`
  and the actor has a live membership of that owner.
  `X = (SELECT authorized_owner_id())` is TRUE in exactly that case.
  - Where the old call was FALSE, the comparison is FALSE (a member, another
    owner) or NULL (no live membership, or a setting unset).
  - NULL filters a row under `USING` and fails `WITH CHECK` exactly as FALSE
    does. Each policy is TRUE in the same cases as before, so combining
    permissive (OR) and restrictive (AND) policies admits the same rows.
- This needs the comparison in a positive position, joined to the rest of the
  clause by AND alone. Under NOT, IS [NOT] FALSE, COALESCE, a simple CASE
  operand or a function argument, NULL does not act as FALSE; under OR or in a
  CASE branch the owner check would no longer bind every row. At 0044 no policy
  uses the call in any of these: every such use is inside the decision-4
  helpers. The guard and `migrations/CLAUDE.md` keep it that way.
- Once per statement. The subquery has no outer reference, so the planner
  makes it an InitPlan.
  - It is computed at most once per execution, and it is not recomputed when a
    correlated subplan around it is rescanned, because it depends on no
    parameter.
  - A statement therefore runs a fixed number of membership checks, one per
    owner-table reference, whatever the number of rows.
  - `statement_timestamp()` is fixed within a statement, and a STABLE function
    reads with the statement's snapshot. The membership window and the rows the
    check sees are the ones the per-row check saw.
  - A statement that changes `unai.owner_scope_id` or `unai.actor_id` while it
    runs keeps the owner its first evaluation returned; the old shape re-read
    the settings per row. Either way a row is admitted only for an owner the
    actor then had a live membership of.
- `(SELECT unai_private.has_owner_access(owner_scope_id))` would NOT have
  worked: it references the row, so it stays a correlated SubPlan run per row.

## Consequences and known limits

1. Membership evaluations per statement become constant. Measured by
   `packages/context/src/owner-statistics.test.ts` (40 fresh frames) before and
   after 0045:
   - `readableFrameCandidates` 815 to 2 and 364 to 2 (its two batches);
   - `proposition_slots` 740 to 95 and 240 to 29; what remains is its per-row
     `object_state_at` helper calls, which are linear;
   - `independentVerification` 80 to 4 per call, over 81 calls;
   - task-be2a16f3's delta and known-claims statements 286 to 6 and 441 to 89.

   No statement of the packet exceeds the 534 bound any more; the largest
   before were 1760 and 1046 evaluations.
2. Tuple fetches do not change. The nested-loop rescans under a one-row
   estimate remain (1640 claim fetches per `independentVerification` call,
   about 1000 to 1400 slot fetches per candidate batch); that half is
   task-7d2ca414.
3. Every new owner policy uses the new shape. A plan written before 0045 that
   adds an old-shape policy fails the guard and must be rewritten.
4. `ALTER POLICY` takes ACCESS EXCLUSIVE on each owner table until the
   migration commits. ADR 0043 D12 runs migrations at its step 5, under D11
   maintenance mode.
5. The function is one more definer that reads membership past forced RLS, on
   the same premise as `has_owner_access` (`migrations/CLAUDE.md`; ADR 0009 was
   never implemented).
6. `packages/capabilities/src/projection-replay.test.ts` re-applies 0045 over
   itself. The function is therefore `CREATE OR REPLACE` and is never in that
   test's drop list: the pre-0016 tables keep their rewritten policies, which
   depend on it. The re-applied rewrite finds only the policies the replay
   recreated in the old shape.
7. `pg_dump` orders the function before the policies that depend on it, as it
   does for `has_owner_access`, so a restore re-creates both.

## Proof

- `packages/postgres/src/owner-policies.test.ts`: the `pg_policies` and
  `pg_depend` inventory guard, the positive-conjunct check, the function's
  attributes and grants, and its equivalence with `has_owner_access` for a live
  member, another owner, a non-member, a disabled user, an expired and a future
  membership, a deleted scope and unset settings.
- `packages/context/src/owner-statistics.test.ts` case (b) bounds every
  execution of `readableFrameCandidates` and `proposition_slots` at linear
  membership evaluations. It fails before 0045 and passes after.
- `packages/postgres/src/isolation.test.ts`, `assertOwnershipCoverage` and the
  `DATABASE_ROLE_UNSAFE` refusals pass unchanged, and so does `pnpm test`.
