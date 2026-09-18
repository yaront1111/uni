# packages/memory

`@unai/memory` owns canonical identity: the entity service, the temporal
resolver, the belief-slot and proposition store with its versioned fingerprints,
and the claim store. It owns no HTTP route, no job and no projection. Schema
lives in `migrations/0010_canonical_identity.sql`; the decisions behind it are
ADR 0015 and the delivery report is `docs/canonical-identity.md`.

It also owns canonicalization and bitemporal state (`canonicalize.ts`,
`instances.ts`, `relations.ts`, `bitemporal.ts`): the BASE-context default with
source attribution, frame-instance matching with its five outcomes, claim
relations that tell a correction from a change, and the three query modes of
PRD §12.3. Schema: `migrations/0013_canonicalization_and_bitemporal.sql`;
decisions: ADR 0018; report: `docs/canonicalization-and-bitemporal.md`.

It also owns outcomes (`resolutions.ts`): the `resolution_assertions` and
`memory_links` stores, transition-contract validation, the resolution-statement
reader and the derived outcome projection. Schema:
`migrations/0015_resolution_assertions_and_links.sql`; decisions: ADR 0020;
report: `docs/resolutions-and-outcomes.md`.

It also owns owner read-your-writes (`overlay.ts`): the `owner_sequences`
allocator, the `owner_overlay_deltas` store the owner's every device reads, and
the `memory_operations` record of the ten correction controls. Schema:
`migrations/0014_owner_overlay_and_corrections.sql`; decisions: ADR 0019; report:
`docs/owner-overlay-and-corrections.md`. The HTTP controls over it are
`packages/api/src/corrections.ts`, not this package. Deciding
*what to believe* is still the write governor's (`@unai/belief`); the one writer
here that touches `belief_assessments`, `recordBeliefStateVersion`, appends a
recorded-time version at a stated knowledge time and names the governed
transaction it belongs to.

It also owns the semantic index (`embeddings.ts`): the pinned
`hashed-lexical-256-0.1.0` embedder, `indexClaimEmbeddings` (called by the
belief governor inside every commit) and `searchMemoryEmbeddings`, which runs the
owner, permission, sensitivity, knowledge-time, time-window, source and entity
filters inside a `MATERIALIZED` expression *before* ranking by distance. Keep it
that way: a filter moved after the `ORDER BY`, or an approximate index queried
first, lets the nearest match cross a boundary (CRT-RD-04-A). The embedded text is
canonical memory only, never raw evidence. Schema: `migrations/0018_semantic_index.sql`;
decisions: ADR 0023; report: `docs/semantic-index-and-ask.md`.

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
- `recordClaim` takes an optional `extractionRunId`, null for a claim the owner
  or a connector stated directly. Migration 0011 replaced the placeholder
  `CHECK(extraction_run_id IS NULL)` of ADR 0015 §1 with the composite owner
  foreign key to `extraction_runs`; no existing claim row was altered.
- **Confidence stays four values.** `recordClaim` and `readClaim` keep
  extraction, entity-resolution, temporal-resolution and instance-resolution
  confidence apart. Never combine them into one number (CRT-MEM-14-A).
- **Canonicalization defaults to BASE and refuses extractor-chosen context.**
  `resolveCanonicalContext` answers BASE unless a caller-supplied `ContextRule`
  names another kind, and it never creates a context space. A request carrying
  `contextKind`, `contextSpaceId` or `extractorContext` is rejected with
  `EXTRACTOR_CONTEXT_SELECTION_REFUSED`; reported speech is handled by
  `classifySourceAttribution` and `claims.asserted_by_entity_id` instead
  (CRT-REG-06-A, PRD §11.6).
- **Only a CONFIRMED_MATCH reuses a frame instance.** `mayReuseInstance` is the
  single decision point, `recordInstanceMatchCandidate` refuses a reuse behind
  any other outcome, and the schema check `instance_match_reuse_confirmed` holds
  the same line for every principal. Do not add a score threshold that reuses
  (CRT-MEM-11-A, CRT-MEM-11-C, PRD §13.4).
- **A correction is not a change.** `recordCorrection` restates one valid
  interval and supersedes the corrected value; `recordChange` closes the earlier
  period and accepts the new one from the change instant, leaving the earlier
  value ACCEPTED. Both axes are half-open, and `claim_relations` refuses
  `CORRECTS` with a new period or `SUPERSEDES` with the old interval
  (CRT-MEM-09-A, PRD §57).
- **Recorded time only moves forward.** `recordBeliefStateVersion` refuses a
  knowledge time in the future or earlier than what is already recorded, and only
  ever closes an existing version's window. Never write a past knowledge time
  around it (CRT-MEM-06-A).
- **An owner sequence is allocated, never chosen.** `allocateOwnerSequence` is the
  only caller of `unai_private.allocate_owner_sequence`, and the row lock that
  statement takes is what makes the numbers increase in *commit* order. Do not
  replace it with a PostgreSQL sequence, a `max()+1` read or a client-side
  counter: all three break CRT-RYW-01-A while still looking monotonic.
- **The overlay is owner-wide.** `source_device_id` and `source_session_id` are
  audit columns. Never filter a read by them, and never add a policy that does:
  the cross-device guarantee of CRT-RYW-02-A and CRT-RYW-02-B is exactly the
  absence of such a filter.
- **Re-extraction contests and stops.** `contestOverlayDelta` is the whole write
  the extraction path has over a delta. REJECTED_AS_INTERPRETATION, SUPERSEDED
  and WITHDRAWN need the owner's own `memory.correct` purpose, enforced by the
  `overlay_delta_transition` trigger for every principal (CRT-MEM-15-A).
- **An outcome is a separate record, never an edit.** `resolutions.ts` only
  inserts, and its two tables take no `DELETE` grant and a lifecycle-only
  `UPDATE`. Never add an outcome, status or `resolved_at` column to a frame, slot
  or proposition table: registry lint already refuses a status *predicate*
  (CRT-OUT-01-A), and a schema column would be the same second authority one level
  down (CRT-OUT-01-B, CRT-OUT-03-A, CRT-OUT-05-A).
- **The outcome projection is derived on read.** `frameOutcomeProjection`
  recomputes UNRESOLVED / PARTIALLY_RESOLVED / RESOLVED / CONTESTED from accepted
  assertions every time; do not materialize it here. Only two *different settling*
  codes conflict — a partial beside a settling one is a progression
  (CRT-OUT-08-A, ADR 0020 §2).
- **A transition contract is an argument, never a file read.** `validateTransition`
  takes the pinned release's contracts from the caller, so an empty set refuses
  everything. This package must not import `@unai/registry` at runtime
  (CRT-REG-01-B), and `transitionContractSchema` stays non-strict so a release
  contract can be passed through unmodified (CRT-OUT-04-A, ADR 0020 §3).
- **A resolution statement creates no slot.** `canonicalizeResolutionStatement`
  shares no step with `canonicalizeClaim`: no slot, no proposition, and its claim
  carries `proposition_id` null. `classifyResolutionStatement` answers `null` for
  anything unrecognised, negated or not-yet-actual rather than guessing a code.
- **Time passage writes nothing.** `sweepElapsedSchedules` reports and returns
  `occurrencesCreated: 0`; never give it an `INSERT` (CRT-OUT-03-A, CRT-OUT-07-A).
- Recomputation appends and closes; it never rewrites. `recomputeCanonicalFingerprints`
  inserts the new-version rows before closing the old ones, so no reader is left
  without an index, and the database's `FINGERPRINT_IMMUTABLE` trigger enforces
  that only `valid_to_recorded_at` moves.

## Running these tests

`temporal.test.ts` is pure: `pnpm exec vitest run packages/memory/src/temporal.test.ts`.
`identity.test.ts`, `canonicalization.test.ts`, `overlay.test.ts` and
`resolutions.test.ts` need the harness — run `pnpm test`, or export
`UNAI_TEST_DATABASE_URL` for a throwaway, already-migrated pgvector server. They
create the `memory_test_app`, `canonicalization_test_app`, `overlay_test_app` and
`resolutions_test_app` LOGIN roles when absent and run every store through
`withOwnerTransaction` under the low-privilege application role, so the policies
of migrations 0010, 0012, 0013, 0014 and 0015 are part of what they prove. No
`UNAI_TEST_S3_*` is needed.

`resolutions.test.ts` reads the pinned release's transition contracts with
`lintRegistryCheckout` from `@unai/registry` (a devDependency, test-only), so it
must run from the repository root; it commits no `registry_releases` row.

`overlay.test.ts` holds two owner transactions open at once to prove the
allocator serializes them, so it needs a pool that can give out two connections;
do not cap that pool at one.

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
