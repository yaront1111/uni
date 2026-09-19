# Evolving personal understanding implementation plan

**Goal:** Turn retained evidence into an accurate, evolving understanding that helps the owner recall changes, recover unfinished commitments, and prepare useful next actions.
**Architecture:** Extend the existing temporal memory, Context Broker, durable queue, and product surfaces. Keep current understanding rebuildable from governed memory, evaluate freshness independently of confidence and retention, and preserve V0's read/draft action boundary.
**Tech Stack:** TypeScript, Zod, Fastify, Next.js, PostgreSQL/pgvector, encrypted S3, the existing model gateway and Git-versioned semantic registry.

**Date:** 2026-09-19. **Inspected baseline:** `fbce0aa`.
**Status:** Planning and PRD clarification only. Findings below are source-level observations, not reproduced integration-test results or fixed defects. The earlier review mentioned in the product direction was not supplied; these observations come from inspecting this checkout.

The changed product authority is [PRD.md](../../PRD.md), particularly §§8.5–8.6, 12.7–12.10, 23.8, and 44.21–44.28. Existing phase order remains in force: a later feature does not excuse a missing earlier correctness gate. Deliver each task as a separate, reviewable change; do not implement this whole roadmap in one patch.

## 1. What exists and what is missing

| Area | Observed implementation | Gap to close |
| --- | --- | --- |
| Temporal memory | `packages/memory/src/bitemporal.ts` and `packages/context/src/selector.ts` distinguish world and knowledge time. | The entire broker packet must obey those boundaries, not just its selection result. |
| Pending owner corrections | `packages/memory/src/overlay.ts` supplies immediate owner-visible deltas. | `broker.ts` does not gate overlay raw text on its supporting source's purpose/sensitivity or requested knowledge time. |
| Today privacy | `packages/context/src/today.ts` requires a supplied belief from a frame before admitting that frame's projection. | It then reads amount, description, time, and names from projections/entities without proving each field was authorized. |
| Retrieval | `broker.ts` loads a default maximum of 100 frames, ordered by creation time, before semantic search. | A semantic hit on an older frame adds evidence but does not load that frame into the already-computed selection. |
| Aging | Confidence/support, valid intervals, retention rules, and briefing rank already exist. | No explicit registered, versioned freshness policy or freshness provenance was found. |
| Processing | `packages/jobs/src/index.ts` implements leases/retries; `packages/extraction/src/worker.ts` exposes an extraction handler. | There is no running processing entry point. The handler stops at candidate extraction. |
| Production composition | `packages/api/src/server.ts` composes storage and connectors. | It supplies neither registry release nor gateway; document extraction queueing requires a registry release. Ordinary evidence/connector import does not complete governed understanding. |
| Today/Ask | `apps/web/lib/screens.ts` loads real API routes; Ask has deterministic answer composition. | Seeded-state tests do not prove source ingestion reaches these screens. Today excludes targets older than 14 days and uses constant goal relevance. |
| Initiative/actions | Repeat suppression, attention budgets, drafts, and action history exist. | Evaluation is requested by screens; no scheduled initiative service or external executor exists. V0 explicitly refuses external action grants. |

Relevant existing reports: [context](../context-broker.md), [extraction](../model-path-and-extraction.md), [queue](../jobs-runtime.md), [Today/Ask](../today-and-ask.md), [actions](../governed-action-and-data-control.md). Their historical test results do not establish current end-to-end readiness.

## 2. Task A: Close privacy and knowledge-time gaps

**Files to modify:**

- `packages/context/src/broker.ts`: authorize overlay support and construct every packet collection from knowledge-eligible inputs.
- `packages/context/src/today.ts`: use authorized per-field values and provenance, including entity labels and resolution state.
- `packages/memory/src/overlay.ts`: expose the temporal/source selection needed by the broker without weakening immediate owner reads.
- `packages/context/src/fragments.ts`: verify projection fragments cannot reintroduce withheld fields.
- Tests: `packages/context/src/context.test.ts`, `packages/context/src/answering.test.ts`, `packages/api/src/today.test.ts`, `packages/api/src/ask.test.ts`, and deletion/retrieval cases in `packages/api/src/control.test.ts`.

1. Add a restricted pending assertion, both attached and unattached, with a distinctive marker. Read at PRIVATE sensitivity and at a purpose forbidden by that assertion's source. Include a separate permitted control source so the request succeeds and retrieves the control marker; a blanket request denial does not test the leak. Assert the protected marker is absent in the returned packet, persisted packet, answer, and captured phrasing input. A correctly authorized read must still contain it.
2. Create value A at T1, value B plus an overlay at T2, with B valid before T1. At knowledge time T1, assert B's value and the overlay text are absent from the whole packet, including conflicts and evidence references. Latest-knowledge corrected history must include B. Separately, record a known assertion whose valid interval starts after the requested world time: it must not enter `currentBeliefs` or Today through a fallback, while an explicitly requested view of the applicable future interval can retrieve it.
3. Materialize an obligation containing a PRIVATE description and RESTRICTED amount. PRIVATE Today must omit the amount from both its response and stored edition; RESTRICTED Today must include it. Repeat for restricted descriptions, participant names, and field-level REDACT verdicts.
4. Run the database-backed suite through `pnpm test`; capture the failing assertions before changing production code. A harness provisioning failure does not reproduce the defect.
5. Build packet candidates from source-authorized and knowledge-eligible rows before values enter any packet array. Enforce the cutoff on supporting claims, assessments, relations, overlays, and resolutions. Do not interpret an absent historical assessment as permission to supply a later proposition as provisional.
6. Carry authorized values into Today by field; a frame ID is not permission to read all its projection fields. When support is unavailable, omit or mark the field unknown. Do not bypass the Context Broker with a wider read.
7. Extend deletion/retrieval coverage: erase a supporting source, then repeat Ask, Today, and historical retrieval after summaries or answers previously included its distinctive marker. Deleted information must not reappear as usable context through derivatives or caches; a missing source does not resolve its former commitment. Preserve an unrelated authorized control fact. Extend the existing control erasure/invalidation path where the regression demonstrates a gap.
8. Rerun the regressions, full test harness, typecheck, and boundary tests. Inspect persisted payloads as well as UI output.

The following **new test helper** makes assertions over actual serialized surfaces, rather than checking only the selector's verdict. Pair each negative check with an authorized positive check so an empty-result implementation cannot pass:

```ts
import { expect } from 'vitest';

function expectMarkerAbsent(marker: string, surfaces: readonly unknown[]): void {
  expect(surfaces.length).toBeGreaterThan(0);
  for (const surface of surfaces) {
    expect(surface).toBeDefined();
    expect(JSON.stringify(surface)).not.toContain(marker);
  }
}

function expectMarkerPresent(marker: string, surface: unknown): void {
  expect(surface).toBeDefined();
  expect(JSON.stringify(surface)).toContain(marker);
}
```

**Exit:** PRD §§44.25–44.26 pass at packet, persistence, and product boundaries. No claim that downstream grounding alone fixes an upstream disclosure.

## 3. Task B: Add explicit aging policy and provenance

**Proposed new files:** `packages/domain/src/aging.ts` (schemas), `packages/memory/src/aging.ts` (pure evaluation), `packages/memory/src/aging.test.ts` (clock/provenance tests).
**Existing files to extend:** `packages/registry/src/schema.ts`, `packages/registry/src/lint.ts`, `packages/domain/src/context.ts`, `packages/context/src/broker.ts`, `packages/context/src/wording.ts`, and their package exports. Record the policy/schema decision in a new ADR before implementation. Add a new immutable registry release and additive migration where persistence requires it; never edit an applied migration or released registry.

1. Define stable, bounded-episode, last-known, preference, unresolved, decision-history, and incidental policy semantics from PRD §12.8. Map by registered semantics, not by source type. Unsupported predicates remain unsupported; this task does not invent canonical salary or birthdate contracts that do not yet exist.
2. Use the following **proposed contract**, implemented through the repository's Zod-first domain pattern. These names describe new code, not APIs already present:

```ts
type FreshnessState = 'CURRENT' | 'VERIFY' | 'OUTSIDE_INTERVAL' | 'UNKNOWN';
type AgingKind = 'STABLE' | 'BOUNDED' | 'LAST_KNOWN' | 'PREFERENCE'
  | 'UNRESOLVED' | 'DECISION_HISTORY' | 'INCIDENTAL';

interface FreshnessAssessment {
  policyId: string;
  policyVersion: string;
  state: FreshnessState;
  evaluatedAt: string;
  worldTime: string;
  knowledgeTime: string;
  basisAt: string | null;
  basisPrecision: 'INSTANT' | 'DAY' | 'MONTH' | 'APPROXIMATE' | 'UNKNOWN';
  validFrom: string | null;
  validTo: string | null;
  evidenceIds: readonly string[];
  claimIds: readonly string[];
  reason: string;
}
```

3. Start tests with fixed source time `2025-09-15T09:00:00Z`, import time `2026-09-19T09:00:00Z`, and later evaluation times. Assert that importing, rereading, summarizing, retrying, and re-extracting never advance `basisAt`. Test absent source time, quoted historical assertions, timezone boundaries, and a qualifying new confirmation unavailable at an earlier knowledge cutoff.
4. Test each policy: stable facts retain applicability absent correction; bounded episodes become outside-interval without an opposite claim; last-known/preference values can require verification without losing historical support; an unresolved outcome remains unresolved; decision relevance can increase years later; incidental ranking never deletes evidence.
5. Implement the evaluator as a pure read computation over eligible evidence and a pinned policy. Do not accept access time or processing time as fallback evidence time. Do not mutate assessments, support counts, outcomes, or retention rules. CURRENT describes applicability under the policy, not a guarantee of truth.
6. Attach the assessment to authorized context and manifests. Display evidence age separately from belief certainty. Redact the assessment's evidence references wherever the same source is withheld.
7. Run `pnpm exec vitest run packages/memory/src/aging.test.ts`, expecting a positive passing test count; then `pnpm test`, `pnpm typecheck`, and the registry gates.

**Exit:** PRD §§44.21–44.23 pass. Identical input and policy produce identical freshness; a later policy version can change present interpretation without rewriting the old answer's recorded explanation. Preserve the original policy selection for historical belief-state reproduction; label any re-evaluation under a newer policy explicitly.

## 4. Task C: Retrieve relevant history and derive current understanding

**Files to modify:** `packages/context/src/broker.ts`, `selector.ts`, `ask.ts`, `question.ts`, `packages/memory/src/embeddings.ts`.
**Proposed new file:** `packages/context/src/understanding.ts`, a read-only assembly of sourced current facts, last-known facts, open concerns, and transitions, not a new truth store.
**Tests:** `packages/context/src/semantic.test.ts`, `answering.test.ts`, `question.test.ts`, and a new `understanding.test.ts`.

1. Reproduce the retrieval gap: an old, uniquely named unresolved commitment followed by at least 101 unrelated newer frames. A text-only Ask query must recover the actual commitment value and source. Assert the same result when more irrelevant recent frames are added.
2. Add historical decision and preference-transition examples whose intervals ended before today. Decision reconstruction must return recorded rationale, while a current-state question must not assert the old preference as current. Explicitly distinguish unknown reason from inferred reason.
3. Resolve structured/entity/open-outcome candidates and authorized semantic matches into frame IDs before loading and selecting their beliefs. Apply permissions/time constraints before relevance ranking and budgets. Use deterministic ordering and bounded pagination; increasing the global 100-frame limit is not the repair.
4. Preserve distinct current-state, corrected-history, and historical-belief modes in every retrieval branch. Audit aggregate claim dates and lifecycle/lineage traversal as well as the main selector. Last-known fallback must carry the Task B freshness label.
5. Assemble the understanding view only from broker-authorized context. Link current and previous values, valid/recorded dates, source origin, and recorded change rationale. Surface incomplete processing and unresolved conflicts. A temporary episode must not become a personality summary.
6. Add routing/answer acceptance cases for the five product questions below. Use structured transitions for change questions and actual goal links for focus questions. Do not answer "nothing" when relevant data is withheld, truncated, or awaiting processing.
7. Run focused pure classifier tests with `pnpm exec vitest run packages/context/src/question.test.ts`; run database integration through `pnpm test` and check types.

**Exit:** Older relevant information remains retrievable under load; the current understanding and historical explanation agree with the same governed source state.

## 5. Task D: Complete one production processing journey

**Files to modify:** `packages/api/src/server.ts`, `platform.ts`, `evidence.ts`, `connectors.ts`, `packages/extraction/src/worker.ts`, `packages/belief/src/transactions.ts`, `packages/jobs/src/index.ts`, and `package.json`.
**Proposed new files:** `packages/api/src/processing-runtime.ts` (composition), `packages/api/src/processing-worker.ts` (entry point), and `packages/api/src/processing-runtime.test.ts`.
**Additional integration tests:** `packages/api/src/extraction-pipeline.test.ts`, `source-import.test.ts`, `packages/jobs/src/index.test.ts`.

1. Start with one commitment from imported email and one subsequent owner correction. The test must ingest evidence through the API, execute the composed queue path, and ask about the resulting commitment. Do not seed accepted propositions or manually update the projection used by the assertion.
2. Configure a pinned registry release, the existing model gateway, and owner-scoped worker identity in production composition. Add an explicit `start:worker` script for the new entry point and a startup check that required dependencies are available. Read credentials only through existing secret handles.
3. Make eligible evidence processing durable. Evidence and a recoverable processing intent must survive a crash between ingest and queueing; use an additive transactional outbox or equivalent durable intent with idempotent enqueue. Preserve source-only/index-only routing instead of extracting every item.
4. Carry the original assertion reference time, precision, and timezone into extraction. The current document enqueue path supplies `new Date()` and `UTC`; missing original time must instead remain explicitly unknown unless the source contract justifies that reference.
5. Compose extraction, entity/time/instance resolution, proposed belief transactions, validation/admission, and projection application through their existing package boundaries. Extraction remains a producer of candidate claims; it must not acquire direct authority to accept them. Ambiguous or unsupported semantics stay pending and inspectable.
6. Use `runJobAttempt` for bounded attempts and lease recovery. Extend orchestration with stage idempotency and version bindings so a retry cannot duplicate claims, resolutions, projection deltas, or reminders. Test death after evidence commit, after extraction, after governed commit, and before queue acknowledgment.
7. Verify a running worker launched from the production composition loads the same dependencies the tests use. Exercise a model failure, revoked source access, expired lease, and dead-letter/manual retry. Show pending/failed processing honestly in the product.
8. Run `pnpm test`, `pnpm typecheck`, `pnpm build`, and registry gates. Then run the real-corpus validation under the repository's existing privacy rules; synthetic fixtures alone do not satisfy the real-data exit gate.

**Exit:** PRD §44.27 passes from source ingestion to Today/Ask, with a source-linked commitment and cross-device correction visibility. Report automated fixture evidence, real-corpus evidence, and observed service deployment separately.

## 6. Task E: Make Today, Ask, and initiative useful together

**Files to modify:** `packages/context/src/today.ts`, `ranking.ts`, `packages/api/src/today.ts`, `review.ts`, `apps/web/lib/screens.ts`, `apps/web/pages/today.tsx`, `ask.tsx`.
**Proposed new files:** `packages/api/src/initiative-worker.ts` (bounded owner-scoped scheduled evaluation), with tests adjacent to the runtime.
**Tests:** `packages/context/src/ranking.test.ts`, `packages/api/src/today.test.ts`, and `apps/web/e2e/ask.test.ts` plus an adjacent Today journey test.

1. Add a year-old unresolved obligation and a no-date commitment to a bounded backlog review. Keep ordinary upcoming-event limits, but stop using the 14-day past-target limit as a universal exclusion of unfinished work. Resolved items stay out of the open backlog.
2. Replace the constant goal-relevance component only when evidence links the item to a current goal. Use a neutral, explained fallback when no link exists. Show sources and dates for the proposed focus.
3. Evaluate enabled initiative on new evidence, relevant deadline thresholds, and owner-local schedules. Use the durable queue, not an in-process timer that loses work at restart. Read current permission and attention settings on every attempt.
4. Deduplicate by owner, situation, material state, and trigger threshold across devices and retries. A daily clock tick or regenerated wording is not a material change. Snoozing affects presentation; explicit outcome evidence affects resolution.
5. Prepare a draft for a missing prerequisite only through the existing enabled draft capability. Record draft creation accurately; external execution remains refused. Prove duplicate triggers create at most one intended draft and preserve its source explanation.
6. Validate the following journeys in the actual product surfaces. Test loading, pending processing, missing sources, and permission refusal alongside the successful answers.

| Question | Required proof |
| --- | --- |
| What am I forgetting? | An old unfinished commitment returns with its source and unresolved status. |
| What changed in my life this month? | Recorded transitions distinguish effective dates from when Uai learned them, with corrections separated from actual changes. |
| Given my situation, what should I focus on? | A few recommendations cite current goals, constraints, consequences, and any stale assumptions requiring confirmation. |
| Why did I decide against this before? | The recorded rationale and assumptions return even when old; missing rationale is admitted. |
| What can you handle for me today? | The answer separates available organization/planning/drafts from actions lacking capability or permission. |

7. Run `pnpm test`, `pnpm typecheck`, and `pnpm build`. Validate owner-local dates around a timezone boundary and concurrent retry suppression.

**Exit:** PRD §§44.24 and 44.28 pass within V0. Measure unresolved-item recall, incorrect-current-assertion rate, relevant historical recall, duplicate reminder rate, correction recurrence, and owner effort per completed journey. No claim of improvement without a recorded baseline and comparable follow-up sample.

## 7. Post-V0 execution boundary

External standing permissions are a separate delivery after the above gates, with an ADR and an explicit product scope change. Reuse the action history and policy ports, but add a real bounded grant, execution adapter, live revocation checks, idempotency, reconciliation, and receipts. A prepared draft or accepted recommendation never authorizes sending, trading, or moving money. An unknown execution result must be reconciled before retrying.

## 8. Verification and handoff

For each implementation task: first capture a failing behavioral test, implement the smallest complete path, then run the task's checks and inspect the owned diff. When a migration or registry contract changes, include ownership isolation, immutable-history checks, and migration/release evidence. Keep new contracts, persistence, policy evaluation, orchestration, and tests in focused files.

Use `pnpm test` for database-backed suites: the harness provisions disposable PostgreSQL and storage. It does not forward individual test arguments. Do not aim the harness at a personal or production database or bucket. Pure tests can run directly through `pnpm exec vitest run <exact-file>`.

Before declaring a phase complete, run:

```powershell
pnpm check:phase-exit
pnpm build
```

`check:phase-exit` includes typecheck, the full test harness, registry lint/contracts, synthetic corpus, and real-corpus verification. Real-corpus verification requires owner-local results over at least ten real Gmail threads. If that evidence is unavailable, report that specific unmet gate; do not substitute seeded examples or call the phase complete.

This documentation change requires link/path checks, review of the PRD diff for contradictions, and `git diff --check`. It does not establish any runtime test result, fix the listed defects, launch services, or authorize publishing or external actions.
