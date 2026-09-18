# packages/memory

`@unai/memory` owns canonical identity: the entity service, the temporal
resolver, the belief-slot and proposition store with its versioned fingerprints,
and the claim store. It owns no HTTP route, no job, no projection and no belief
assessment. Schema lives in `migrations/0010_canonical_identity.sql`; the
decisions behind it are ADR 0015 and the delivery report is
`docs/canonical-identity.md`.

## Surface and consumers

- Every store takes a `MemoryTransaction` (`src/transaction.ts`) — just `query` —
  which `OwnerTransaction` from `@unai/postgres` satisfies structurally. Nothing
  here opens a connection, commits, audits, or resolves a secret; the caller has
  already established owner scope, actor, purpose and correlation id as
  transaction-local settings the RLS policies read.
- Runtime dependencies are `zod` and `@unai/domain` only. `pg` and
  `@unai/postgres` are devDependencies, used by `identity.test.ts`.
- `uuidV7` comes from `../../../src/kernel/identities.js`, the same relative path
  `@unai/api`, `@unai/jobs` and `@unai/registry` use.
- The closed vocabularies live in `packages/domain/src/memory.ts` and must stay
  identical to the `CHECK` lists in migration 0010.

## Invariants a change must keep

- **Nothing is keyed by a fingerprint.** `slotFingerprint` and
  `propositionFingerprint` feed lookup and comparison only. Never add a unique
  constraint over a `fingerprint` column, never derive an id from one, and never
  let a lookup return a single id when more than one candidate matched
  (CRT-MEM-04-A, CRT-MEM-04-B).
- **A lookup establishes identity only through semantic comparison.**
  `identityEstablished` is true only when exactly one candidate's stored
  descriptor is canonically equal to the query descriptor. `resolveBeliefSlot`
  and `resolveProposition` create a new row in every other case; they must never
  "pick the best" candidate.
- **A slot excludes the value.** `slotDescriptorSchema` is a `strictObject` with
  five members and no value. Adding one would collapse PRD §11.8 and make
  "ILS 50" and "ILS 60" two slots instead of two propositions (CRT-MEM-05-A).
- **Entity resolution under-merges.** Only an exact, unambiguous match on a
  strong alias type (`STRONG_ALIAS_TYPES` in `entities.ts`) reuses an entity. Do
  not add a confidence threshold, a similarity score or a name-based shortcut;
  ADR 0015 §3 records why. A merged entity is retired and stays resolvable
  through `MERGED_INTO` lineage (CRT-MEM-11-B).
- **The temporal resolver never invents precision.** `EXACT_INSTANT` is reachable
  only from text that already carried an instant. An unrecognised phrase answers
  `null`; it must not fall back to the reference instant. Adding a phrase means
  adding it with the precision it honestly has (CRT-MEM-07-A).
- **Confidence stays four values.** `recordClaim` and `readClaim` keep
  extraction, entity-resolution, temporal-resolution and instance-resolution
  confidence apart. Never combine them into one number (CRT-MEM-14-A).
- Recomputation appends and closes; it never rewrites. `recomputeCanonicalFingerprints`
  inserts the new-version rows before closing the old ones, so no reader is left
  without an index, and the database's `FINGERPRINT_IMMUTABLE` trigger enforces
  that only `valid_to_recorded_at` moves.

## Running these tests

`temporal.test.ts` is pure: `pnpm exec vitest run packages/memory/src/temporal.test.ts`.
`identity.test.ts` needs the harness — run `pnpm test`, or export
`UNAI_TEST_DATABASE_URL` for a throwaway, already-migrated pgvector server. It
creates the `memory_test_app` LOGIN role when absent and runs every store through
`withOwnerTransaction` under the low-privilege application role, so the policies
of migration 0010 are part of what it proves. No `UNAI_TEST_S3_*` is needed.

## Traps

- Test files share one database and run in parallel. Never commit a
  `registry_releases` row: `packages/registry/src/snapshot.test.ts` asserts the
  whole database holds exactly one. That is also why the fingerprint tables record
  `registry_release_id` without a foreign key (ADR 0015 §2).
- Tests inside `identity.test.ts` share one owner scope and run in declaration
  order. `recomputeCanonicalFingerprints` closes every `normalization-1` index row
  for that owner, so a test added after the CRT-MEM-04-A case cannot assume the
  default normalization version still has live index rows.
- Adding a table here means the full checklist in `migrations/CLAUDE.md` and
  `packages/postgres/CLAUDE.md`: classification in `ownership.ts`, a cross-owner
  fixture in `isolation.test.ts`, and the literal table count in "forces RLS on
  all application tables".
