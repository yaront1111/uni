# Typed projections, replay, and the commitment, obligation and schedule capabilities

Authority: goal-b2cc3b54-1876-401e-a6a2-527f99b679bc design v1, sealed graph
3a910def2655f69aa3feb9855e481cbda6d643a7325e83e4844b56bd2351c494, node key
`typed-projections-replay-and-commitment-obligation-caps`, and approved
contract-uai-v0/rev-uai-v0-001. This node owns CRT-MEM-08-A, CRT-OUT-06-A,
CRT-OUT-07-A, CRT-PRJ-01-A, CRT-PRJ-02-A, CRT-PRJ-02-B, CRT-PRJ-03-A,
CRT-PRJ-04-A, CRT-PRJ-07-A and CRT-RYW-04-A. ADR 0021 records its decisions;
ADRs 0001–0020 and the delivered foundation, evidence, registry, queue,
canonical-identity, model, write-governor, canonicalization, owner-overlay and
resolution slices were inspected and retained unchanged.

## Design entities implemented here

**`open_commitments_projection`**, **`obligations_projection`**,
**`schedule_projection`** and **`projection_rebuild_receipts`**, added by
`migrations/0016_typed_projections.sql` with forced RLS, purpose-gated policies,
composite owner foreign keys and an identity trigger on each projection table.
Every earlier table is preserved and none gains a column. There are now 46
application tables, 44 of them owner-scoped and classified in
`packages/postgres/src/ownership.ts`.

`decision_projection` is **not** implemented here: it is P6 and belongs to
`goals-decisions-prediction-review-and-mentor`.

## Design screens this node serves

It draws no UI. It delivers the data and the HTTP surface the design's
**Commitments**, **Obligations**, **Commitment detail** and **Projection health**
screens read:

| Screen state (design) | What answers it |
| --- | --- |
| Commitments: open commitments with due dates, related people and sources | `GET /v1/projections/commitments` rows with `dueTime`, `promisorEntityId`, `promiseeEntityId`, `sourceManifest` |
| Commitments: overdue flag set by the clock with no FAILED or MISSED resolution | `overdue` on the row; asserted against the whole owner's `resolution_assertions` |
| Commitments: resolved / partially resolved / contested | `outcomeState`, from `frameOutcomeProjection` |
| Commitments: pending owner correction applied to the read | the read's in-memory overlay fold, `sourceStrength: PENDING_OWNER_ASSERTION` |
| Commitments: incomplete read returning persisted state plus the pending assertion and blocking high-risk actions | `isComplete: false`, `pendingAssertions`, `highRiskActionsBlocked` |
| Commitments: completeness flag and owner overlay watermark shown | `isComplete`, `ownerOverlayWatermark` on every view |
| Commitments: filtered by person, thread or due window | `?person=`, `?dueBefore=`, `?dueAfter=`, `?includeResolved=` |
| Commitment detail: promisor, promisee, action description, due time, modality COMMITTED | `canonicalizeCommitmentStatement` and the row it produces |
| Commitment detail: consideration-only statement kept as evidence with no commitment created | `classifyCommitmentLanguage` → `CONSIDERATION`, `created: false` |
| Commitment detail: target-less FULFILLED resolution from a direct completion statement | `recordCommitmentCompletion` |
| Obligations: typed principal amount, currency and due time | the typed columns |
| Obligations: canonical allocated total with the remaining amount recomputed by the capability | `totalCanonicalAllocation`, `remainingAmountCapabilityDerived` |
| Obligations: advisory coverage shown and labelled advisory, never arithmetic input | `sourceManifest.advisoryCoverageIgnored` |
| Obligations: unallocated payment remainder shown as unknown | `unclassifiedRemainder`, null when unknown |
| Obligations: two conflicting amounts both retained and shown | `conflictFlag`, `sourceManifest.conflictingAmounts`, `calculateObligation(...).conflicts` |
| Projection health: versions, reducer versions and watermarks; incomplete rows with their pending assertions; rebuild receipts; replay equal to incremental | `GET /v1/ops/projections` |

The React views themselves stay with
`commitments-obligations-inspector-and-correction-controls` (CRT-UX-04-A,
CRT-UX-07-A) and the operations console with `ci-pipeline-operations-runbooks-and-v0-release-gate`;
nothing was added to `apps/web`.

## Packages

**`@unai/domain`** gains `projections.ts`: the money, projection-name,
rebuild-trigger, source-strength and pending-assertion vocabularies; the three
typed row schemas and the view envelope they share; the rebuild receipt, the
projection-health view, the obligation calculation with its conflict record, and
the commitment-language reading. Money crosses every boundary as an exact decimal
*string*, never a number.

**`@unai/capabilities`** is new, and exists so that CRT-OUT-06-A is checkable:

- `money.ts` — the only exact-decimal arithmetic in the repository. Scaled
  `BigInt`, no rounding, no currency conversion.
- `canonical.ts` — the read side every reducer shares. Every query has a total
  `ORDER BY`; nothing reads the wall clock.
- `commitments.ts` — `classifyCommitmentLanguage`,
  `canonicalizeCommitmentStatement`, `recordCommitmentCompletion`.
- `obligations.ts` — `readObligationState`, `readAllocations`,
  `computeObligationArithmetic` (pure) and `calculateObligation`, which reports
  conflicts and refuses a HIGH-risk answer over a disputed slot.
- `schedule.ts` — the scheduled frames and their realization and resolution.
- `projections.ts` — one reducer, `applyProjectionDelta`, `replayProjection`,
  the three reads and `readProjectionHealth`.
- `replay.ts` — `runProjectionReplay`, what `uai registry projection-replay` runs.

**`@unai/api`** gains `projections.ts`: `GET /v1/projections/commitments`,
`/obligations`, `/schedule` under purpose `projection.read`, and
`GET /v1/ops/projections` under `ops.projections.read`.

**`@unai/registry`** gains the `registry projection-replay` CLI command. It loads
the capability package lazily inside its own branch, so `uai registry lint` still
runs with no database driver in the process.

## Acceptance

`packages/capabilities/src/money.test.ts` (pure),
`packages/capabilities/src/projections.test.ts` and
`packages/capabilities/src/projection-replay.test.ts` (real PostgreSQL through the
real owner boundary), `packages/api/src/projections.test.ts` (the real HTTP
boundary), `src/architecture.test.ts` and the schema guards in
`packages/postgres/src/isolation.test.ts`.

| Criterion | Where |
| --- | --- |
| CRT-PRJ-01-A typed amount, currency, due-time and start/end columns | "CRT-PRJ-01-A": the three tables read out of `information_schema`, each named column's `data_type` asserted, and the only JSONB in all three shown to be `source_manifest` |
| CRT-PRJ-02-A replay equals incremental, and replaying twice is identical | "CRT-PRJ-02-A": twenty generated steps from a seeded sequence (obligation, allocation, commitment, accepted completion, owner correction, due-time change), the projections applied incrementally after each; then full replay compared row-content by row-content against the incremental state, and a second replay against the first |
| CRT-PRJ-02-B drop and rebuild reproduces identical rows | `projection-replay.test.ts`, on a database of its own: the four tables dropped outright, migration 0016 re-applied from Git, `runProjectionReplay` rebuilding from canonical memory, every row compared column by column with the snapshot — including an `is_complete=false` row and its pending assertion |
| CRT-PRJ-03-A nine non-null fields on every row of every projection table | "CRT-PRJ-03-A": the projection tables read from the catalog rather than a hand-kept list, every row checked field by field, `reducer_version` and the UUIDv7 shape of `projection_version` asserted, and `information_schema` shown to declare every one of the nine `NOT NULL` |
| CRT-PRJ-04-A completeness flag and overlay watermark on both reads | `api/projections.test.ts` "CRT-PRJ-04-A": both routes over the real boundary, `isComplete` and `ownerOverlayWatermark` typed and present, plus the watermarks, reducer version and pending assertions; and the filter and purpose refusals |
| CRT-PRJ-07-A commitment vs consideration language, and target-less FULFILLED completion | "CRT-PRJ-07-A": the classifier on all three sentences; the created `shared.commitment` with both slots at modality `COMMITTED` and no status predicate; consideration language leaving the frame count unchanged; "Done, I sent it" producing a target-less `FULFILLED` assertion under `shared.commitment.resolution` while the commitment's slot rows keep their `xmin` |
| CRT-OUT-06-A no kernel arithmetic, and remaining recomputed despite a wrong advisory coverage | `src/architecture.test.ts` walks `@unai/memory` and `src/kernel` for arithmetic over money-named operands and for a dependency on the capability package; "CRT-OUT-06-A" sets `advisory_coverage` to 0.01 and then 0.99 and shows the recomputed remaining and the unclassified ILS 10 unchanged |
| CRT-OUT-07-A the clock sets overdue and creates no FAILED or MISSED | "CRT-OUT-07-A": the same commitment read before and after the due time, `overdue` moving false→true with `outcomeState` still `UNRESOLVED`, the owner's resolution-assertion count unchanged, no `FAILED` or `MISSED` row anywhere, and `sweepElapsedSchedules` returning both counters zero |
| CRT-MEM-08-A both conflicting amounts retained, high-risk calculation reports the conflict | "CRT-MEM-08-A": a user amount and a document amount in one slot, both propositions `ACTIVE` and retrievable; the HIGH-risk calculation `blocked` with `HIGH_RISK_CALCULATION_OVER_CONFLICTING_SLOT` and both values and origins in `conflicts`; the LOW-risk calculation still reporting it; `conflict_flag` on the row |
| CRT-RYW-04-A pending correction applied, forced-impossible read incomplete with the assertion, high-risk action blocked | "CRT-RYW-04-A": an owner correction reflected in the very next read; then a correction in another currency, which the reducer refuses to convert, giving `isComplete=false`, the persisted amount still returned, the pending assertion with `DELTA_CURRENCY_CONVERSION_REFUSED`, `EvaluateMemoryAction` answering `DENY`/`HIGH_RISK_ACTION_ON_UNSETTLED_MEMORY`, and the capability's own HIGH-risk calculation blocked; then the contested lifecycle still pending |

`pnpm test` (51 files, 483 tests) is the gate and passes; `pnpm typecheck` and
`pnpm validate:registry` also pass.

Three behaviours worth stating because they are easy to assume the other way:

- **A projection read writes nothing.** It folds the owner's later corrections
  over the persisted rows in memory. That is how a correction made on another
  device is in *this* answer without a read purpose holding a write grant.
- **A rebuild changes exactly one column.** `projection_version` identifies the
  run that wrote the row. `updated_at` and `last_material_update` are derived
  from the canonical inputs, so they survive a rebuild unchanged, and the
  row-content comparison covers them.
- **`advisory_coverage` is read and never used.** It is carried out in
  `sourceManifest.advisoryCoverageIgnored` and in
  `ObligationCalculation.advisoryCoverageIgnored` so a surface can label it
  advisory, and it appears in no expression.

## What this node does not claim

- **No UI.** The Commitments, Obligations, Commitment detail and Projection
  health screens are drawn by
  `commitments-obligations-inspector-and-correction-controls` and
  `ci-pipeline-operations-runbooks-and-v0-release-gate`. `apps/web` is unchanged,
  including its same-origin proxy, which still forwards POST only: a browser
  cannot reach these GET routes until that node adds the mapping.
- **No belief transaction and no governed acceptance.** A capability may propose;
  committing stays `@unai/belief`'s. `recordCommitmentCompletion` records a
  *proposed* resolution unless the caller supplies the governed transaction id.
- **No extraction.** `classifyCommitmentLanguage` reads a sentence a caller
  already has and is a deterministic reader, not a model.
- **No merge, split or lineage.** `projection_rebuild_receipts` carries the
  `MERGE` and `SPLIT` triggers so
  `merge-split-lineage-and-uuidv7-identity-invariant` writes into the table
  rather than migrating for it; this node writes neither.
- **No context packet and no answer manifest.** `readCommitmentsProjection` and
  `readObligationsProjection` are what the Context Broker will consume for
  CRT-RD-05-A; the broker is `context-broker-packets-explain-and-memory-threads`'s.
- **No deletion cascade.** A projection row is removed by
  `drafts-actions-permissions-export-and-deletion-workflow`'s cascade
  (CRT-SEC-11-A); the `DELETE` grant that makes it possible exists here.
- **No `decision_projection`** and no registry release 0.2.0.

## Known gap

`schedule_projection.preparation_requirement` has a typed column and is always
null: registry release 0.1.0 declares no preparation-requirement predicate, and
releases are immutable. PRD §25.3 lists the field as *suggested*, so no
acceptance criterion rests on it. The row's `source_manifest` records
`preparationRequirementPredicate: null` so the absence reads as "no contract
defines it". ADR 0021 §10 records the decision; the gap is submitted as a
finding.

## Configuration

Two new purposes and no new environment variable. `memory.project` is the
reducer's: it reads across canonical memory and is admitted by no INSERT, UPDATE
or DELETE policy outside the projection tables. `projection.read` sees the
projection rows and the owner overlay and no canonical table at all.
`ops.projections.read` reads the health view. The replay CLI takes
`UNAI_DATABASE_URL` and `UNAI_DATABASE_CA_PATH`, which the runtime already uses:

```
pnpm uai registry projection-replay --owner-scope <uuid> --actor <uuid> \
  [--projection <name|all>] [--as-of <iso>] [--report <path>]
```

It exits non-zero with `PROJECTION_REPLAY_DIVERGED` when a replay does not
reproduce the incrementally maintained rows, so CI sees a divergence as a failure
rather than as a successful rebuild.
