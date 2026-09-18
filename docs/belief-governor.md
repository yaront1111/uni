# The write governor

Authority: goal-b2cc3b54-1876-401e-a6a2-527f99b679bc design v1, sealed graph
3a910def2655f69aa3feb9855e481cbda6d643a7325e83e4844b56bd2351c494, node key
`belief-transactions-assessments-support-and-policy-ports`, and approved
contract-uai-v0/rev-uai-v0-001 (digest
22027aaaeea527eb7b1d2ae3dab70bfabda8ff13c660bf0e0839356f91fe1339). This node owns
CRT-AI-02-A, CRT-MEM-01-A, CRT-MEM-12-A, CRT-MEM-12-B, CRT-MEM-13-A, CRT-REG-06-B,
CRT-WRT-02-A, CRT-WRT-02-B, CRT-WRT-03-A and CRT-WRT-04-A. ADR 0017 records its
decisions before the code; ADRs 0001–0016 and the delivered foundation, evidence,
registry, queue, canonical-identity and model slices were inspected and retained.

**This node implements no screen.** It underlies states of the **Memory
inspector** another node draws — "Current belief with its assessment status",
"Historical timeline over valid time and recorded time", "Inferences with their
recorded dependencies", "Derived belief shown as UNSUPPORTED after all its inputs
were invalidated" — and adds the three governed write routes the design's API
surface already specifies.

## Entities

`belief_transactions`, `belief_transaction_operations`, `belief_assessments`,
`belief_support`, `derived_proposition_dependencies` and `policy_decisions`, added
by `migrations/0012_belief_governor.sql` with forced RLS, purpose-gated policies
and composite owner foreign keys. Every earlier table is preserved. There are now
35 application tables, 33 of them owner-scoped and classified in
`packages/postgres/src/ownership.ts`.

The migration also completes the handoff ADR 0015 recorded:
`entity_lineage.transaction_id` and `frame_instances.created_by_transaction_id`
lose their placeholder `CHECK(... IS NULL)` and gain composite owner foreign keys
to `belief_transactions`; `context_spaces.creation_transaction_id` gets the same
key, so no column in the schema names a transaction nothing can resolve. No
existing row is altered — the columns are null on every row and stay null there.
`claims` and `propositions` gain the governed `UPDATE` policy, grant and identity
guard migration 0010 deliberately left to this node.

## Packages

- **`@unai/belief`** — the governor. `proposeBeliefTransaction`,
  `validateBeliefTransaction`, `commitBeliefTransaction` and `readCommitReceipt`;
  the append-only assessment engine (`recordBeliefAssessment`,
  `readCurrentAssessment`, `readAssessmentHistory`) with
  `recordDerivedDependency` and `reassessDerivedPropositions`; the support graph
  (`independenceGroupKey`, `derivedIndependenceGroupKey`, `findSupportCycle`); the
  seven admission modes (`selectAdmissionMode`, `autoAcceptConditionsWithheld`,
  `admittedAssessmentStatus`); and the three local policy ports
  (`createLocalPolicyAdapters`, `recordPolicyDecision`, `readPolicyDecision`).
  Every function takes a transaction runner the caller supplied, as
  `@unai/extraction` does.
- **`@unai/domain`** — `governance.ts` adds the closed vocabularies, the
  operation union, and the propose, validation-report and commit-receipt shapes.
- **`@unai/api`** — `memory.ts` registers `POST /v1/memory/transactions/propose`,
  `/{id}/validate` and `/{id}/commit` under the new `memory.govern` purpose.

## What holds, and where it is proved

| Criterion | Where |
| --- | --- |
| CRT-AI-02-A derived proposition stores inputs, evaluator, versions, release, calculation inputs and time, and becomes UNSUPPORTED once every input is invalidated | `packages/belief/src/governor.test.ts` ("derived beliefs") |
| CRT-MEM-01-A an ACCEPTED assessment over an absent predicate or frame type is refused and leaves no accepted assessment | `packages/belief/src/governor.test.ts` (both absences, plus the registered control) |
| CRT-MEM-12-A repeated messages, quoted history and a model summary of one source are one independence group | `packages/belief/src/support.test.ts`, `packages/belief/src/governor.test.ts` |
| CRT-MEM-12-B circular accepted support is rejected | `packages/belief/src/support.test.ts`, `packages/belief/src/governor.test.ts` |
| CRT-MEM-13-A a calendar event keeps modality SCHEDULED across assessment and claim-origin changes; all eight modalities are accepted | `packages/belief/src/governor.test.ts` ("modality, context and the governed boundary") |
| CRT-REG-06-B exactly one active BASE context per owner scope; a QUOTED→BASE move outside a governed transaction is refused | `packages/belief/src/governor.test.ts`, `packages/postgres/src/isolation.test.ts` |
| CRT-WRT-02-A a failing last operation leaves no earlier operation visible | `packages/belief/src/governor.test.ts` |
| CRT-WRT-02-B committing twice under one key is one commit with identical receipts | `packages/belief/src/governor.test.ts`, `packages/api/src/memory.test.ts` |
| CRT-WRT-03-A a DENY is not committed and the decision records outcome, reason and policy version | `packages/belief/src/governor.test.ts` |
| CRT-WRT-04-A each admission mode is exercised; a candidate failing any AUTO_ACCEPT condition is not auto-accepted | `packages/belief/src/admission.test.ts`, `packages/belief/src/governor.test.ts` |

`pnpm test` (43 files, 425 tests) is the gate; `pnpm typecheck` and
`pnpm validate:registry` also pass.

## What this node does not claim

- **No merge, split, archive or delete.** Those operation kinds are refused with
  `BELIEF_OPERATION_NOT_DELIVERED` (ADR 0017 §9). Merge and split with lineage
  belong to `merge-split-lineage-and-uuidv7-identity-invariant`, archive to the
  correction-controls node, the deletion cascade to the export-and-deletion node.
- **No projection.** A commit receipt carries `affectedProjections: []` and
  `projectionRebuildReceipts: []`. Reducers and rebuild receipts are the
  typed-projection node's deliverable, and the receipt claims no rebuild it did
  not perform.
- **No resolution assertion, memory link, owner overlay or bitemporal query
  operator.** Those are `resolution-assertions-links-and-outcome-projection`,
  `owner-sequence-overlay-deltas-and-correction-endpoints` and
  `canonicalization-instance-matching-and-bitemporal-queries`.
- **No screen and no web page.** The three routes are server-side; the browser
  proxy (`apps/web/pages/api/platform/[...path].ts`) is untouched, because the
  Memory inspector surface belongs to another node.
- **No conflict *resolution*.** Validation reports a material conflict and
  withholds `AUTO_ACCEPT`; deciding between two competing accepted values is the
  correction and merge workflow's work.
- **`EvaluateMemoryRead` and `EvaluateMemoryAction` are delivered as ports with
  local adapters and persisted decisions, and are not yet called by a read or
  action path** — the Context Broker and the action/draft surfaces that will call
  them are later nodes. `EvaluateMemoryWrite` is wired into every commit.
