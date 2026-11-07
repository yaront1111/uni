# ADR 0048: Registry pin changes: queued extraction and existing memory

Date: 2026-11-06

Status: Accepted. Amends ADR 0038's "A processing ledger pins the registry
release" as D1 states: the ledger still pins the release, but a pending item
with no stage output moves to the worker's pin. Recorded before the code (PRD §0
rule 7). Source: task-4f28cd51's plan (architect-5d342ffe, 2026-11-07).

## Context

- `createProcessingRuntime().handle` refuses any `evidence.extract` job whose
  payload `registryReleaseId` differs from the worker's pin
  (`packages/api/src/processing-runtime.ts:52`, `PROCESSING_RELEASE_MISMATCH`).
  That code is not in `TERMINAL_EXTRACTION_ERROR_CODES`
  (`packages/extraction/src/worker.ts:23`), so the job fails three attempts and
  dead-letters.
- A dead-letter retry resets only `status` and `attempt_count`
  (`retryDeadLetterJob`, `packages/jobs/src/index.ts:129-135`), and the `jobs`
  trigger refuses any payload change (`JOB_IDENTITY_IMMUTABLE`,
  `migrations/0007_jobs.sql:57`). A retry therefore replays the old release and
  fails again.
- `enqueueEvidenceProcessing` refuses a ledger row pinned to another release
  (`packages/api/src/processing-store.ts:35`), and `dispatch()` selects only rows
  whose `job_id` is null (`packages/api/src/processing-runtime.ts:40-43`).
  Nothing re-dispatches a row that already has a job.
- `deploy/upgrade.sh` step 6 (`publish_release`, `repin`) rewrites only
  `UNAI_REGISTRY_RELEASE` and `UNAI_REGISTRY_RELEASE_ID` and touches no queue.
  So every extraction job queued before a re-pin is stranded.
- `recomputeCanonicalFingerprints` (`packages/memory/src/slots.ts:241`) has no
  production caller. `slotFingerprint` and `propositionFingerprint`
  (`packages/memory/src/slots.ts:55-70`) hash the normalization version plus the
  descriptor, never a release id; `CANONICAL_NORMALIZATION_VERSION` is
  `normalization-1` (`packages/memory/src/slots.ts:28`).
- The typed-projection reducer (`packages/capabilities/src/projections.ts`) reads
  canonical tables and no registry contract.
- PRD §22.1: every extraction run records its registry release, and
  re-extraction creates new claims without mutating old ones. §22.2 defines the
  lazy, targeted, shadow and full re-extraction modes. §22.3: a new release must
  not silently replace previous semantic history. §17.7 and §25.4: identity- and
  transition-affecting registry changes carry a migration manifest and a
  projection replay.

## Decision

### D1. The release of an item's stages

- The job payload's `registryReleaseId` records the pin at dispatch. It no
  longer decides whether the job may run.
- The ledger row's `registry_release_id` is the release the item's stages run
  under.
- A row still `PENDING` is re-pinned to the worker's release when no
  `SUCCEEDED` `extraction_runs` row exists for its dispatch release's processing
  key. The re-pin happens in the ledger, inside the item's advisory lock, with a
  `status='PENDING'` guard. The item is then extracted, canonicalized and
  governed under the new release.
- A row with stage output finishes under the release it began with. Stage
  output means status `EXTRACTED`, `CANONICALIZED` or `GOVERNED`, or a `PENDING`
  row whose dispatch-release run already succeeded before a lost ledger update.
- So one item's extraction run, canonical writes and governed transaction never
  mix releases. The run and transaction idempotency keys,
  `processingKey(sourceItemId, release)`, stay those of the first attempt, so a
  retry reuses work instead of repeating it.
- The job keeps its id and its immutable payload; only the ledger moves.

### D2. Dead letters and re-requests

- A re-pin re-queues nothing by itself. A dead letter stays an explicit
  operator retry (ADR 0012): `POST /v1/ops/dead-letter/{id}/retry` or the Jobs
  screen `/ops/jobs`.
- A retried dead letter then follows D1. That includes a job an earlier build
  dead-lettered with `PROCESSING_RELEASE_MISMATCH`.
- `enqueueEvidenceProcessing` returns the item's existing job, whatever release
  dispatched it. A document re-uploaded with full extraction after a re-pin
  therefore gets that job back instead of failing.
- `PROCESSING_RELEASE_MISMATCH` remains only as the worker's startup refusal
  when `UNAI_REGISTRY_RELEASE_ID` and `UNAI_REGISTRY_RELEASE` disagree
  (`packages/api/src/processing-worker.ts`).

### D3. No fingerprint recomputation on a re-pin

- Fingerprints hash the normalization version plus the descriptor. The release
  is recorded on each index row but is not a hash input (ADR 0015 §2), so every
  row stays valid under any pin.
- Recomputation belongs to a change of the code constant
  `CANONICAL_NORMALIZATION_VERSION`. The change that first bumps it must wire
  `recomputeCanonicalFingerprints` into production in that same change. A test
  pins the constant.
- A release that renames a predicate changes descriptors, not hashes. Lookups
  miss the old slots and canonicalization creates new candidates (PRD §22.3).
  Relating new and old slots is a governed MERGE (ADR 0025), never a fingerprint
  rewrite.

### D4. No projection replay on a re-pin

- The reducer (`REDUCER_VERSION`, `packages/capabilities/src/projections.ts`)
  reads canonical tables and no registry contract, so a re-pin alone changes no
  projection row.
- PRD §25.4's replay during relevant migrations stays step 5 of
  `docs/operations/registry-migration.md` (`uai registry projection-replay`). A
  governed release's migration manifest must carry its report (CRT-REG-05-A).
- Not decided here: a code release that changes `REDUCER_VERSION`. Rows carry
  `reducer_version`, but no reader compares it with the running reducer.

### D5. Existing memory keeps its release

- Claims, canonical objects and governed transactions keep the release they
  were made under (PRD §22.1). A re-pin re-extracts and rewrites nothing.
- A newer release reaches existing evidence only through re-extraction (PRD
  §22.2); task-4a6269d9 delivers that job path.
- Read-time consumers follow the new pin at once: aging policies
  (`packages/memory/src/aging.ts`, `migrations/0032_contextual_aging_policy_reader.sql`)
  and the governor's contract checks.
- This narrows the task objective "nor leaves existing memory on the old
  semantics" to new and queued work.

## Consequences

- `deploy/upgrade.sh` needs no drain step, and ADR 0043 D12 is unchanged; the
  script gains only a header comment.
- `deploy/README.md` `## Upgrade` tells operators D1, D2 and D5.
- `packages/api/src/processing-worker.ts` keeps its startup check.
- No migration, table, purpose or route changes: the ledger update runs under
  `memory.extract`, which `evidence_processing`'s `owner_drive` policy already
  admits (`migrations/0031_durable_evidence_processing.sql:40-43`).

## Verification

`packages/api/src/processing-release.test.ts`, on a scratch database holding
releases 0.1.0 and 0.3.0:

- (a) a job dispatched under 0.1.0 and run by a worker pinned to 0.3.0 succeeds,
  with the ledger row, the extraction run and the governed transaction on 0.3.0;
- (b) a job dead-lettered under 0.1.0 and retried through
  `POST /v1/ops/dead-letter/{id}/retry` completes under 0.3.0;
- (c) an item interrupted after each of the four checkpoints under 0.1.0
  finishes under 0.1.0 with one model call, one succeeded run and one committed
  transaction;
- (d) `POST /v1/documents` re-requesting extraction through an API pinned to
  0.3.0 answers 201 with the job queued under 0.1.0, which then completes under
  0.3.0;
- (e) `CANONICAL_NORMALIZATION_VERSION` is pinned to `normalization-1` (D3).
