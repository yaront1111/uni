# @unai/capabilities

The commitment, obligation and schedule capabilities, and the typed projections
they maintain. Report: `docs/typed-projections.md`. Decisions: ADR 0021. Schema:
`migrations/0016_typed_projections.sql`.

## Why this package exists at all

PRD §16.7 and §26.4 say the Memory Kernel performs no financial arithmetic. This
package is where that arithmetic lives instead, so the rule is a boundary rather
than a habit. `src/architecture.test.ts` (in the repo root `src/`) walks
`packages/memory/src` and `src/kernel` and fails on any `+ - * / % **`, compound
assignment or `++`/`--` whose operand text names an amount, an allocation, a
principal, a balance, a coverage or a payment — and on any dependency from
`@unai/memory` on this package. If you move a sum into the kernel, that test
tells you.

## Local invariants

- **Money is a decimal string across every boundary and a scaled `BigInt` in
  every computation.** `money.ts` is the only place either happens. Never a
  `number`: `0.1 + 0.2 !== 0.3`, and an obligation balance is where that becomes
  a wrong statement about somebody's money. An amount with more than six
  fractional digits is refused, never rounded.
- **No currency conversion.** `sumMoney`, `subtractMoney` and `compareMoney`
  throw `MONEY_CURRENCY_MISMATCH` across currencies. A rate is a claim about the
  world and this package has no evidence for one.
- **`advisory_coverage` is never an input.** It is read and carried out under a
  name that says so (`advisoryCoverageIgnored`). If it appears on the right-hand
  side of anything, CRT-OUT-06-A is broken.
- **One reducer.** `applyProjectionDelta` and `replayProjection` differ only in
  which frames they hand to `buildRows`. Do not add a fast path that updates a
  column in place; "incremental equals full replay" is only true because there is
  nothing else to drift.
- **Determinism.** Every query has a total `ORDER BY`, every selection rule
  breaks ties on an identifier, and nothing reads the wall clock: `updated_at`
  and `last_material_update` are the newest *input* time, and `asOf` is a
  parameter. `projection_version` is the one column a rebuild changes, and
  `projectionRowContent` excludes exactly it.
- **Readers follow lineage** (ADR 0025 §3). A merged frame's slots, roles,
  resolutions, realizations and allocations are read for its survivor, a
  merged proposition's claims count for the one it merged into, a claim a split
  assigned (support row of a SPLIT transaction) counts for the new proposition,
  and a merged entity reads as its survivor. With no lineage every map is the
  identity; keep it so, or replay stops equalling what earlier nodes asserted.
  A full replay removes rows of frames it no longer projects, and
  `rebuildProjectionsAfterLineageChange` is the merge/split rebuild with one
  receipt per projection, idempotent per transaction.
- **A read writes nothing.** `readCommitmentsProjection` and its siblings fold
  the owner's overlay over the persisted rows in memory. They run under
  `projection.read`, which no projection INSERT policy admits.
- **Nothing here opens a connection, commits, audits, calls a model or reaches
  the network.** Every function takes a transaction the caller opened inside the
  owner boundary, as `@unai/memory` and `@unai/belief` do.

## Purposes

| Purpose | What it may do |
| --- | --- |
| `memory.project` | Read every canonical table the reducer needs; write, restate and delete projection rows; append a rebuild receipt. It is admitted by no INSERT, UPDATE or DELETE policy on any canonical table. |
| `projection.read` | Read the projection rows and the owner overlay. No canonical table at all, which is why the read takes the canonical watermark from the rows instead of recomputing it. |
| `ops.projections.read` | Read `projection_rebuild_receipts` for the Projection health screen. |

## Change checklist

- A new projected column: add it to the migration (typed, not JSONB, `NOT NULL`
  if it is one of the nine PRD §33.12 fields), to the row schema in
  `@unai/domain/projections.ts`, to the reducer, to the `INSERT ... ON CONFLICT`
  write and to the `to*Row` read. Missing one of the last two is silent: the
  round-trip test in `projections.test.ts` is what catches it.
- A new projection table: add it to `PROJECTION_NAMES`, to `FRAME_COLUMN`, to the
  `projection_name` CHECK on `projection_rebuild_receipts`, to
  `packages/postgres/src/ownership.ts` and to the isolation fixtures. The
  CRT-PRJ-03-A test reads the table list from the catalog, so it will start
  covering the new table on its own.
- A new owner delta kind the reducer should honour: add it to one of the four
  sets in `foldOwnerDeltas`. The default is to report it as pending, which is the
  safe direction — an unfolded write is visible, a silently ignored one is not.

- **`computeProjectionRows` writes nothing.** It is the replay's compute half,
  and the shadow evaluation calls it inside a READ ONLY transaction (ADR 0031
  §4). A statement that writes in `buildContext` or `buildRows` would fail every
  owner-sample shadow run.

## Traps

- `numeric` arrives from node-postgres as a **string**. Keep it one; `Number()`
  on a money column undoes the point of the typed column.
- Postgres preserves the scale it was given, so `'50'` comes back `'50'` and
  `'50.00'` comes back `'50.00'`. Compare amounts with `sameMoney`, not `===`.
- `bigint` also arrives as a string; `owner_overlay_watermark` is read through
  `Number(...)` and checked.
- The database-backed tests need the harness: run `pnpm test`.
  `projection-replay.test.ts` creates and drops a database of its own, because
  dropping the projection tables on the shared suite database would fail whatever
  suite happened to be running beside it.
