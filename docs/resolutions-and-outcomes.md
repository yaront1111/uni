# Resolution assertions, protocol links and the outcome projection

Authority: goal-b2cc3b54-1876-401e-a6a2-527f99b679bc design v1, sealed graph
3a910def2655f69aa3feb9855e481cbda6d643a7325e83e4844b56bd2351c494, node key
`resolution-assertions-links-and-outcome-projection`, and approved
contract-uai-v0/rev-uai-v0-001. This node owns CRT-OUT-01-B, CRT-OUT-02-A,
CRT-OUT-03-A, CRT-OUT-04-A, CRT-OUT-05-A and CRT-OUT-08-A. ADR 0020 records its
decisions; ADRs 0001–0019 and the delivered foundation, evidence, registry,
queue, canonical-identity, model, write-governor, canonicalization and owner-overlay
slices were inspected and retained unchanged.

**This node implements no screen.** It delivers the **Commitment detail** screen's
resolution and outcome states — the accepted resolution assertions of a frame, the
REALIZES and RESOLVES links that carry them, and the UNRESOLVED /
PARTIALLY_RESOLVED / RESOLVED / CONTESTED reading — for the node that draws that
screen (`commitments-obligations-inspector-and-correction-controls`).

## Entities

`memory_links` and `resolution_assertions`, added by
`migrations/0015_resolution_assertions_and_links.sql` with forced RLS,
purpose-gated policies, composite owner foreign keys and a transition trigger on
each that refuses every column but `lifecycle` and `metadata`. Every earlier table
is preserved and none gains a column. There are now 42 application tables, 40 of
them owner-scoped and classified in `packages/postgres/src/ownership.ts`.

- **`memory_links`** carries the ten protocol link kinds of PRD §11.13 —
  `SUPPORTS`, `CONTRADICTS`, `SUPERSEDES`, `DERIVED_FROM`, `SAME_AS`,
  `NOT_SAME_AS`, `PART_OF`, `REFERENCES`, `REALIZES`, `RESOLVES` — as a closed
  list. `REALIZES` and `RESOLVES` must name a transition contract; the schema
  check `memory_link_transition_named` makes one without unrepresentable.
- **`resolution_assertions`** carries the columns of PRD §33.8: source frame
  required, target optional, claim required, outcome code from the twelve of PRD
  §16.5, transition contract `NOT NULL`, and `advisory_coverage` as a nullable
  fraction nothing reads.

## Packages

**`@unai/domain`** gains `outcomes.ts`: the link-kind, object-type, outcome-code,
resolution-lifecycle and outcome-projection-state vocabularies, the stored-row
display schemas, and `transitionContractSchema` — a *non-strict* object so a
pinned release's own transition contract can be handed to the kernel unmodified.

**`@unai/memory`** gains `resolutions.ts`, pure functions over a transaction the
caller opened inside the owner boundary:

- **`validateTransition`** — the single decision point for PRD §34.5 rule 5. Seven
  named refusals, one per clause of the contract.
- **`recordMemoryLink`, `listMemoryLinks`** — the protocol links. Direction reads
  as the English does: `from` REALIZES/RESOLVES `to`.
- **`recordResolutionAssertion`, `readResolutionAssertion`,
  `listResolutionAssertions`, `setResolutionLifecycle`** — the assertion and its
  RESOLVES link, written together after validation, and a lifecycle move that
  requires `memory.govern` or `memory.correct` (and a transaction id to accept).
- **`recordRealization`** — the REALIZES link an actual occurrence gets. It carries
  no outcome; the outcome is a separate RESOLVES assertion.
- **`classifyResolutionStatement`, `canonicalizeResolutionStatement`** — the path a
  sentence like "It is settled" takes. It resolves no slot and creates no
  proposition; the claim it records carries `proposition_id` null.
- **`frameOutcomeProjection`** — UNRESOLVED / PARTIALLY_RESOLVED / RESOLVED /
  CONTESTED, derived on every read from accepted assertions and stored nowhere.
- **`sweepElapsedSchedules`** — the scheduled frames whose time has passed, and
  `occurrencesCreated: 0`, `resolutionsCreated: 0` as literal types.

## Acceptance

All in `packages/memory/src/resolutions.test.ts`, over real PostgreSQL through the
real owner boundary, with the transition contracts read out of
`registry/releases/0.1.0` by the registry library so the rule is checked against
the release's YAML and not a copy of it; plus the schema-level guards in
`packages/postgres/src/isolation.test.ts`.

| Criterion | Where |
| --- | --- |
| CRT-OUT-01-B 'It is settled', 'I completed it' and 'The meeting was cancelled' canonicalize as resolution assertions and create no status slot | "CRT-OUT-01-B": three assertions with the right outcome codes and claims carrying no proposition; the owner's belief-slot and proposition counts unchanged; no status-shaped predicate anywhere. Plus a negation/future case and the propose-versus-accept case |
| CRT-OUT-02-A 'It is settled; I paid him in cash' creates a resolution assertion with a source obligation frame, null target, outcome FULFILLED and a required claim ID | "CRT-OUT-02-A": the row field by field, the claim read back with the supporting clause, the RESOLVES link from the assertion to the obligation, and the obligation's own slot, proposition and claim untouched |
| CRT-OUT-03-A a calendar event stays SCHEDULED; attendance creates an actual occurrence with REALIZES and RESOLVES (OCCURRED); a cancellation creates a CANCELLED resolution; an event past its date produces no occurrence | "CRT-OUT-03-A": the scheduled slot still SCHEDULED and still the instance's only slot after realization; both links from the actual occurrence to the schedule; a target-less CANCELLED on a second event; `sweepElapsedSchedules` on a third returning it UNRESOLVED with no realizing occurrence and both counters zero |
| CRT-OUT-04-A an outcome the referenced transition contract does not allow, or no transition contract, is refused | "CRT-OUT-04-A": eight refusals — disallowed code, the three prediction codes under the pinned release, null/undefined/empty contract, unknown contract, wrong link kind, wrong source frame type, wrong target frame type, missing required target — and no assertion or orphan link left behind |
| CRT-OUT-05-A after CONFIRMED, REFUTED or PARTIALLY_CONFIRMED the PREDICTED proposition and its claims remain unchanged and retrievable | "CRT-OUT-05-A": for each of the three codes, the slot row, the proposition row and every claim row compared column by column before and after the realization, the resolution and its acceptance; the claim read back through the store |
| CRT-OUT-08-A the outcome projection reads UNRESOLVED, PARTIALLY_RESOLVED, RESOLVED and CONTESTED | "CRT-OUT-08-A": all four, plus a proposed-but-not-accepted resolution leaving UNRESOLVED, a partial beside a settling code still RESOLVED, and a rejection returning a contested frame to RESOLVED with both assertions still on record |

`pnpm test` (47 files, 456 tests) is the gate and passes; `pnpm typecheck` and
`pnpm validate:registry` also pass.

Three behaviours are worth stating because they are easy to assume the other way:

- **A partial outcome beside a settling one is a progression, not a conflict.**
  Only two *different settling* codes make a frame CONTESTED. "He paid half" then
  "he paid the rest" is the ordinary history of an obligation.
- **Proposing an outcome never moves the projection.** The projection reads
  accepted rows only, and accepting needs `memory.govern` (or the owner's
  `memory.correct`) plus the governed transaction id.
- **Nothing here writes to an existing row.** Both tables are append-plus-lifecycle
  and their triggers bind the migration owner too, so a REALIZES or RESOLVES link
  cannot become a way to rewrite what it points at.

## The owner route: POST /v1/memory/resolutions

`packages/api/src/resolutions.ts` is the production writer of resolution
assertions (PRD §16.1-§16.4, §18.7, §35.6). It needs a session holding
`memory.govern`, `x-data-purpose` and `x-maximum-sensitivity` (else 400
`MEMORY_CONTEXT_REQUIRED`) and an `idempotency-key`. The web proxy pins
`PERSONAL_ASSISTANCE` and `RESTRICTED` for it, as for every `memory.govern` path.

Body (`resolutionSubmissionSchema`, strict): `statement` (the owner's words,
1-8192 characters), optional `sourceFrameInstanceId`, `targetFrameInstanceId`,
`outcomeCode`, `effectiveAt` (an offset is accepted and stored as UTC; never in
the future), `candidateFrameTypes` (only without a source) and `sourceDeviceId`.
A target without a source, a target equal to the source, or candidate frame
types next to a source is 400 `RESOLUTION_INPUT_INVALID`.

Three paths:

- **Target-linked** (source and target): the RESOLVES link runs from the target
  frame to the source frame.
- **Target-less** (source only): the link runs from the resolution assertion to
  the source frame.
- **No item** (no source): the words become an owner overlay delta of kind
  `USER_ASSERTION` with lifecycle `AWAITING_INSTANCE_RESOLUTION` (PRD §14.2,
  §44.5). The answer is `status: AWAITING_SOURCE` with the delta id and owner
  sequence. Typed projection reads list it in `pendingAssertions` with reason
  `DELTA_NOT_ATTACHED`, and `GET /v1/memory/overlay-deltas` lists it, so it is
  never dropped. No resolution assertion is written.

The outcome code is the deterministic classifier's reading of the statement
(`classifyResolutionStatement`), or the owner's explicit `outcomeCode`. A
statement it cannot read with no code is 422 `RESOLUTION_STATEMENT_UNRECOGNIZED`;
a code that disagrees with the reading is 422
`RESOLUTION_OUTCOME_DISAGREES_WITH_STATEMENT`.

On the two governed paths:

1. The transition contract is the pinned release's single RESOLVES contract
   whose source frame types include the source frame's type, read through
   `unai_private.registry_release_transition_contracts`.
   `validateTransition` checks the target type and the outcome code before
   anything is written. The governor checks again at commit.
2. The statement is stored as evidence under `memory.correct`, through
   `ingestOwnerStatement`, as one `MESSAGE_SPAN` anchor. It is `PRIVATE`
   (ADR 0028 §4), or `NORMAL` when the request's ceiling is `NORMAL`.
3. A RESOLVE belief transaction is proposed and committed at risk LOW with the
   evidence as its source:
   - an `ADD_CLAIM` (`USER_STATEMENT`, `CANDIDATE`, no proposition);
   - the `RESOLVE` operation.
   The assertion is therefore ACCEPTED under AUTO_ACCEPT. The outcome claim has
   no proposition, so the Source page lists it as a `REPORTED` candidate
   (ADR 0047 D2).
4. The source frame's typed projection rows are rebuilt under `memory.project`
   and audited. This step is needed because a projection read folds the owner
   overlay over the stored rows and recomputes nothing: without the rebuild,
   `GET /v1/projections/commitments` would keep reporting a done commitment as
   unresolved and overdue. No overlay delta is written on these paths; the
   outcome is canonical.

The answer is `status: COMMITTED` with the assertion, transaction, evidence and
claim ids, the contract, the lifecycle and the frame's outcome state, read back
from the stored rows.

Idempotency: the belief transaction's key is the request's key.
- A retry answers 200 with the same body, from the committed transaction (the
  first answer is 201).
- A simultaneous duplicate answers the first request's transaction.
- A key already spent on another outcome, or on the other path, is 409
  `IDEMPOTENCY_KEY_REUSED`.
- Different words under a used key are 409 `IDEMPOTENCY_CONFLICT`, from the
  evidence store.

Refusals, each audited DENY/REFUSED after the refused work rolled back:

| Status | Code |
| --- | --- |
| 400 | `MEMORY_CONTEXT_REQUIRED`, `RESOLUTION_INPUT_INVALID` |
| 403 | `PURPOSE_REFUSED` (boundary, not audited by the route), `EVIDENCE_POLICY_REFUSED` |
| 404 | `RESOLUTION_SOURCE_NOT_FOUND`, `RESOLUTION_TARGET_NOT_FOUND` |
| 409 | `RESOLUTION_SOURCE_NOT_ACTIVE`, `RESOLUTION_TARGET_NOT_ACTIVE`, `IDEMPOTENCY_KEY_REUSED`, `IDEMPOTENCY_CONFLICT`, `BELIEF_TRANSACTION_REFUSED`, `BELIEF_TRANSACTION_REJECTED` |
| 422 | `RESOLUTION_STATEMENT_UNRECOGNIZED`, `RESOLUTION_OUTCOME_DISAGREES_WITH_STATEMENT`, `RESOLUTION_CONTRACT_UNAVAILABLE`, the `TRANSITION_*` codes of `validateTransition` (for example `TRANSITION_OUTCOME_REFUSED` for WAIVED on a commitment) |
| 503 | `REGISTRY_RELEASE_NOT_CONFIGURED`, `STORAGE_UNAVAILABLE`, `RESOLUTION_UNAVAILABLE` (logged as ALLOW/FAILURE) |

What it does not do:
- write REALIZES links;
- resolve an obligation from a payment allocation (task-20a2d1bc);
- attach an unattached delta to the frame it turns out to name (task-75d63589).

Tests: `packages/api/src/resolutions.test.ts` (database-backed, through
`app.inject`) and `apps/web/lib/memory-proxy.test.ts` (the proxy mapping).

## What this node does not claim

- **No screen.** The Commitment detail screen, the Memory inspector's resolution
  panel and the correction controls belong to
  `commitments-obligations-inspector-and-correction-controls`; the Commitments
  screen control that calls the route is task-271f9aa7. The HTTP route exists:
  `POST /v1/memory/resolutions` under `memory.govern`, registered in
  `PLATFORM_PURPOSES` and `routePurpose` (`packages/api/src/platform.ts`) and in
  the web proxy as `memory/resolutions` (see "The owner route" above).
- **No typed projection.** `open_commitments_projection`, `obligations_projection`
  and `schedule_projection`, the overdue flag of CRT-OUT-07-A and the allocation
  arithmetic boundary of CRT-OUT-06-A are
  `typed-projections-replay-and-commitment-obligation-caps`'s deliverables; that
  node depends on this one and will read `frameOutcomeProjection` rather than
  restate the rule.
- **No registry loading and no registry contract.** Release 0.1.0 is unchanged and
  unread by any deployed package here; the caller that pinned a release supplies
  its transition contracts. Registry lint's refusal of an outcome status predicate
  (CRT-OUT-01-A) stays `registry-loader-lint-release-0-1-0-and-base-contexts`'s.
- **No belief transaction here.** `recordResolutionAssertion` records a proposal
  and refuses to record an accepted one without a transaction id. An owner's
  outcome is committed by the write governor's RESOLVE operation (task-67c47741,
  `@unai/belief`): ACCEPTED under AUTO_ACCEPT, with the committing transaction as
  `creation_transaction_id`, and PROPOSED otherwise.
- **No extraction.** `canonicalizeResolutionStatement` consumes a statement a
  caller already has; producing it from evidence is `@unai/extraction`'s work, and
  its phrase classifier is a deterministic reader, not a model.
- **No merge, split or lineage**, and **no overlay delta**: those stay with
  `merge-split-lineage-and-uuidv7-identity-invariant` and
  `owner-sequence-overlay-deltas-and-correction-endpoints`.

## Known gap

Registry release 0.1.0 declares no frame admitting PREDICTED modality and no
transition contract allowing `CONFIRMED`, `REFUTED` or `PARTIALLY_CONFIRMED`, so
the prediction review of CRT-OUT-05-A and PRD §44.9 cannot be expressed with a
contract from the pinned release. Releases are immutable and their contents belong
to `registry-loader-lint-release-0-1-0-and-base-contexts`, so nothing under
`registry/` was touched: the store validates against whatever contracts the caller
pins, and the test supplies a prediction-review contract in the registry's own
shape while asserting that the pinned release's contracts refuse those three
codes. ADR 0020 §10 records the decision; the gap is submitted as a finding.

## Configuration

No new environment variable and no new purpose. `POST /v1/memory/resolutions`
runs under the existing `memory.govern` and opens its evidence, owner-entity and
projection transactions under `memory.correct`, `memory.canonicalize` and
`memory.project`, chosen by server code. The two new tables are read under
`memory.canonicalize`, `memory.govern`, `memory.inspect` and `memory.correct`,
inserted under `memory.canonicalize`, `memory.govern` and `memory.correct`, and
their lifecycle moved only under `memory.govern` and `memory.correct`; a session
holding any other purpose reads none of them, and the policies fail closed when
the setting is absent.
