# ADR 0021: Typed projections, projection replay and capability-owned arithmetic

Date: 2026-09-18
Status: Accepted
Node: `typed-projections-replay-and-commitment-obligation-caps` of
goal-b2cc3b54-1876-401e-a6a2-527f99b679bc (design v1, sealed graph
3a910def2655f69aa3feb9855e481cbda6d643a7325e83e4844b56bd2351c494).
Criteria: CRT-MEM-08-A, CRT-OUT-06-A, CRT-OUT-07-A, CRT-PRJ-01-A, CRT-PRJ-02-A,
CRT-PRJ-02-B, CRT-PRJ-03-A, CRT-PRJ-04-A, CRT-PRJ-07-A, CRT-RYW-04-A.

Recorded before the implementing change, per PRD §0.7 and §46.

## 1. A separate package for the capabilities

PRD §16.7, §26.4 and the `shared.obligation` invariant require that the Memory
Kernel perform no financial arithmetic. A rule of that shape is only worth
anything if something checks it, and "we did not write a `-` in that file" is not
checkable by review at the scale the kernel is growing to.

`@unai/capabilities` is therefore a package of its own, holding `money.ts` — the
only exact-decimal arithmetic in the repository — and the commitment, obligation
and schedule capabilities over it. `src/architecture.test.ts` walks
`packages/memory/src` and `src/kernel` and fails on any arithmetic operator whose
operand names an amount, an allocation, a principal, a balance, a coverage or a
payment, and on any dependency from `@unai/memory` on this package. The kernel
cannot cross the boundary directly and cannot delegate across it either.

Rejected: putting the capabilities in `@unai/memory` behind a naming convention.
The convention would hold until the first person who needed a total in a hurry.

## 2. `BigInt` at a fixed scale, and no currency conversion

Money crosses every boundary in this slice as an exact decimal *string* and is
computed on as an integer number of units at a scale of six. `0.1 + 0.2` is not
`0.3` in IEEE-754 and an obligation balance is precisely where that becomes a
wrong statement about somebody's money. An amount with more precision than the
scale is refused rather than rounded.

Adding two amounts in different currencies is refused rather than converted: a
rate is a claim about the world and this capability has no evidence for one. The
refusal surfaces as `currencyMismatchAllocationIds` on the calculation, as
`conflict_flag` on the row, and as `DELTA_CURRENCY_CONVERSION_REFUSED` when the
owner states a correction in another currency.

## 3. Projection identity is the source frame

`open_commitments_projection`, `obligations_projection` and `schedule_projection`
are keyed on `(owner_scope_id, <source frame instance id>)`. A reducer can
therefore only restate the row for a situation, never accumulate two readings of
one, and a full replay lands on exactly the rows an incremental apply did.

## 4. One reducer, two entry points

`applyProjectionDelta` and `replayProjection` differ in which frames they hand to
the same `buildRows`, and in nothing else. There is no in-place column update and
no second implementation, so "incremental equals full replay" (CRT-PRJ-02-A) is a
property of the code rather than a coincidence two implementations maintain.

## 5. Determinism, and the one column a rebuild changes

Every value a row carries is a function of the canonical rows, the owner's
overlay and the `asOf` instant the caller declared. In particular `updated_at`
and `last_material_update` are the newest *input* time and never `now()`, so a
rebuild days later reproduces them.

`projection_version` is the exception, deliberately. It is a UUIDv7 minted per
reducer run and shared by every row that run wrote: it identifies the run, not
the situation. CRT-MEM-03-A requires projection versions to be UUIDv7 surrogates
that are not derived from content, so a deterministic one is not available. The
row-content comparison behind CRT-PRJ-02-A and CRT-PRJ-02-B (`projectionRowContent`)
therefore excludes that one column and compares every other, `updated_at`
included, and the tests separately assert that the rebuild did mint a new one.

`asOf` is an input rather than the clock for the same reason: `overdue` is a
function of the time the reader declared, and PRD §25.4 asks for determinism over
a pinned input set, which includes that instant.

## 6. `memory.project`, a read-everything write-nothing purpose

The reducer needs to read across the whole of an owner's canonical memory and
must write none of it. Migration 0016 adds `memory.project` to the SELECT policy
of the ten tables the reducer reads and to no INSERT, UPDATE or DELETE policy
anywhere outside the projection tables. A capability holding it can restate a
projection row and cannot touch a frame, a slot, a proposition, a claim, a link,
a resolution assertion or an overlay delta. `packages/capabilities/src/projections.test.ts`
asserts the refusal rather than the intent.

`projection.read` is narrower still: the projection rows and the owner overlay,
and no canonical table at all. The read path consequently takes the canonical
transaction watermark from the rows — which recorded it when the reducer wrote
them — instead of recomputing it from `belief_transactions`, because recomputing
it under a purpose that cannot see that table would answer `epoch` instead of
failing.

## 7. Projection rows may be deleted; nothing else may

`migrations/CLAUDE.md` recorded that no migration grants `DELETE` to `unai_app`.
Migration 0016 grants it on the three projection tables and on nothing else, and
the guide is updated to say so. PRD §25.4 requires every projection to be
rebuildable and CRT-PRJ-02-B drops and rebuilds them outright; a projection row
is a cache of canonical memory, so removing one destroys no belief, no evidence
and no outcome. `projection_rebuild_receipts` is append-only like `audit_events`
and takes no UPDATE and no DELETE grant: a receipt is a statement about a run
that happened.

## 8. The read folds the overlay in memory and writes nothing

A `GET /v1/projections/*` request holds a read purpose and performs no write. The
owner's later corrections are folded over the persisted rows in memory, which is
what puts a correction made on another device in *this* answer (CRT-RYW-02-A)
while keeping the read a read. A write the reducer cannot fold in comes back as a
`pendingAssertion` beside the persisted row with `isComplete` false, and
`highRiskActionsBlocked` travels with the answer as the `projectionComplete`
input `EvaluateMemoryAction` consumes (CRT-RYW-04-A).

## 9. Time passage moves two booleans

`overdue` and `due_soon` are computed from `asOf` against the due time and the
derived outcome state. Nothing in the reducer inserts, and
`sweepElapsedSchedules` in `@unai/memory` already returns `resolutionsCreated: 0`
as a literal type. PRD §12.6 and CRT-OUT-07-A are therefore carried by the shape
of the code, and the test additionally asserts that no `FAILED` or `MISSED`
assertion exists anywhere in the owner's memory after the clock advances.

## 10. Known gap: no preparation-requirement predicate

`schedule_projection.preparation_requirement` is drawn by the design and by PRD
§25.3. Registry release 0.1.0 declares no predicate for it, releases are
immutable, and their contents belong to
`registry-loader-lint-release-0-1-0-and-base-contexts`. The typed column exists
and is always null, and the row's `source_manifest` records
`preparationRequirementPredicate: null` so the absence reads as "no contract
defines it" rather than as "nothing to prepare". PRD §25.3 lists the field as
*suggested*, so no acceptance criterion rests on it; it is reported as a finding
rather than filled in by inventing a predicate here.
