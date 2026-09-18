# packages/extraction

`@unai/extraction` owns two services and their storage: triage (Tier-0
deterministic parsing, Tier-1 routing) and extraction (runs producing
span-anchored claims). It owns no HTTP route, no belief, no projection and no
worker process. Schema lives in
`migrations/0011_triage_extraction_and_model_calls.sql` (`triage_decisions`,
`extraction_runs`); the decisions behind it are ADR 0016 and the delivery report
is `docs/model-path-and-extraction.md`.

## Surface and consumers

- `recordTriageDecision(tx, input)` runs **inside the evidence ingest
  transaction** (`packages/api/src/evidence.ts`), which is why the insert policy
  admits `evidence.ingest`. It is idempotent on the source item.
- `runExtraction({runner, gateway, request})` opens three transactions through
  the caller's `ExtractionTransactionRunner`: `memory.extract` to open the run,
  `model.call` inside the gateway, and `memory.canonicalize` to write the claims
  and complete the run atomically with them.
- `createExtractionJobHandler` is the handler for job kind `evidence.extract` on
  the durable queue. This package starts no worker and enqueues nothing; the
  connector sync path decides when an item is extracted.
- Runtime dependencies are `zod`, `@unai/domain`, `@unai/memory` and
  `@unai/model`. `pg` and `@unai/postgres` are devDependencies.

## Invariants a change must keep

- **Triage is pure.** No model, clock, network or random value in `triage.ts`.
  Identical bytes must always yield the identical route and reason; that is what
  lets triage run in the ingest transaction for every item (CRT-WRT-07-A).
- **Triage never fails ingestion.** `triage()` catches its own defects and
  degrades to `SOURCE_ONLY` with reason `TIER1_ROUTER_UNAVAILABLE`. The fallback
  must not depend on the values that just failed. Evidence durability outranks
  classification (PRD §0 rule 5).
- **A negative signal is checked before the positive ones.** A newsletter that
  quotes an amount is still a newsletter (CRT-WRT-07-A).
- **Quoted history is cut once, in Tier 0.** A message that is only quoted
  history routes `SOURCE_ONLY`, so a thread update costs one deep extraction
  rather than one per quoted message (CRT-WRT-07-B). Never make the extractor
  re-read a quoted body.
- **No run without a route.** `openRun` refuses a missing decision
  (`EXTRACTION_TRIAGE_REQUIRED`) and a route that does not admit deep extraction
  (`EXTRACTION_ROUTE_REFUSED`). `DEFER_UNTIL_RELEVANT` is reachable only by a
  `TARGETED` run, which is what "lazy" means.
- **A span is checked, not believed.** `resolveExtractedSpan` refuses a span
  outside its parent anchor or a quote that is not exactly the text at that
  offset, and the whole run fails rather than storing a claim that cannot be
  grounded (CRT-EVD-06-A).
- **Extraction produces claims, never beliefs.** `claim_origin` is
  `MODEL_EXTRACTION`, `proposition_id` is null and lifecycle is `CANDIDATE`.
  Admitting a belief is the Belief Transaction service's work (PRD §19.1).
- **Nothing is edited.** Re-extraction opens a new run and inserts new claim
  rows. The claim store holds no UPDATE grant and a closed run cannot be reopened
  (CRT-WRT-08-A).
- **The evidence gate applies.** Every transaction that reads evidence declares
  `dataPurpose` and `maximumSensitivity` (ADR 0016 §7). Never read around it.

## Running these tests

`triage.test.ts` is pure: `pnpm exec vitest run packages/extraction/src/triage.test.ts`.
The end-to-end path is `packages/api/src/extraction-pipeline.test.ts`, which
needs the full harness (`pnpm test`): it composes the real ingest path, triage,
the gateway, the extraction service and the durable queue, with a provider double
as the only stand-in.

## Traps

- Purpose lists in the policies are literals inside an applied migration. A new
  caller purpose needs a new migration, not an edit to 0011.
- `ROUTE_COST_BUDGET_MICROUNITS` and the
  `triage_decisions_budget_matches_route` CHECK must stay consistent: a deep
  route needs a positive budget, and every other route needs zero.
- Adding a table here means the checklist in `migrations/CLAUDE.md` and
  `packages/postgres/CLAUDE.md`: classification in `ownership.ts`, a cross-owner
  fixture in `isolation.test.ts`, and the literal table count in "forces RLS on
  all application tables".
