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

## What this node does not claim

- **No screen and no HTTP route.** The Commitment detail screen, the Memory
  inspector's resolution panel and the correction controls belong to
  `commitments-obligations-inspector-and-correction-controls`; no route, proxy
  path or purpose was added.
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
- **No belief transaction.** `recordResolutionAssertion` records a proposal and
  refuses to record an accepted one without a transaction id; proposing,
  validating and committing the transaction remain `@unai/belief`'s.
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

No new environment variable and no new purpose. The two new tables are read under
`memory.canonicalize`, `memory.govern`, `memory.inspect` and `memory.correct`,
inserted under `memory.canonicalize`, `memory.govern` and `memory.correct`, and
their lifecycle moved only under `memory.govern` and `memory.correct`; a session
holding any other purpose reads none of them, and the policies fail closed when
the setting is absent.
